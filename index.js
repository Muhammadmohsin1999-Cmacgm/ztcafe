const { initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const {
  calculateDeliveryFee,
  canTransitionPayrollStatus,
  hasManagerPermission: managerPermissionIsAssigned,
  isPakistaniMobile,
  isValidManagerPermissions,
  isValidRoleAssignment,
  ORDER_STATUSES,
  RESERVATION_SEATING,
} = require("./domain");

initializeApp();

setGlobalOptions({
  region: "asia-southeast1",
  maxInstances: 20,
});

const db = getFirestore();
function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in to continue.");
  }
  if (request.auth.token.email_verified !== true) {
    throw new HttpsError(
      "permission-denied",
      "Verify your email address before using cafe services.",
    );
  }
  return request.auth;
}

function roleOf(auth) {
  return typeof auth.token.role === "string" ? auth.token.role : "customer";
}

function isAdmin(auth) {
  return ["admin", "owner"].includes(roleOf(auth));
}

function hasManagerPermission(auth, permission) {
  return (
    managerPermissionIsAssigned(
      roleOf(auth),
      auth.token.managerPermissions,
      permission,
    )
  );
}

function requireManagerPermission(auth, permission) {
  if (roleOf(auth) === "manager" && !hasManagerPermission(auth, permission)) {
    throw new HttpsError(
      "permission-denied",
      `Your owner-assigned manager access does not include ${permission}.`,
    );
  }
}

function staffRoleOf(auth) {
  return typeof auth.token.staffRole === "string"
    ? auth.token.staffRole
    : "";
}

function requireRole(auth, roles) {
  if (
    !roles.includes(roleOf(auth)) &&
    !(roleOf(auth) === "owner" && roles.includes("admin"))
  ) {
    throw new HttpsError("permission-denied", "Your account cannot perform this action.");
  }
}

function requireCustomer(auth) {
  requireRole(auth, ["customer"]);
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${label} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpsError(
      "invalid-argument",
      `${label} must be between 1 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

function optionalText(value, label, maxLength) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpsError("invalid-argument", `${label} is too long.`);
  }
  return value.trim();
}

function integerBetween(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${label} must be a whole number between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function requirePakistaniPhone(value) {
  const phone = requiredText(value, "Phone number", 24);
  if (!isPakistaniMobile(phone)) {
    throw new HttpsError(
      "invalid-argument",
      "Enter a valid Pakistani mobile number.",
    );
  }
  return phone;
}

async function requireEmployeeUser(uid) {
  const user = await getAuth().getUser(uid);
  const employeeRole = user.customClaims?.role;
  if (
    !user.emailVerified ||
    !["staff", "manager", "admin", "hr", "accountant"].includes(employeeRole)
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Choose a verified account with an assigned employee or management role.",
    );
  }
  return user;
}

function requireFutureDate(date, time) {
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    throw new HttpsError("invalid-argument", "Choose a valid date and time.");
  }

  const proposed = new Date(`${date}T${time}:00+05:00`);
  if (Number.isNaN(proposed.getTime()) || proposed <= new Date()) {
    throw new HttpsError(
      "invalid-argument",
      "Choose a reservation time in the future.",
    );
  }
}

function ownProfile(email, data) {
  return {
    fullName: optionalText(data.fullName, "Name", 100),
    phone: data.phone ? requirePakistaniPhone(data.phone) : "",
    email,
    role: "customer",
    rewardPoints: 0,
    membershipLevel: "bronze",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function writeAudit(action, actorId, targetId, metadata = {}) {
  await db.collection("auditLogs").add({
    action,
    actorId,
    targetId: targetId || "",
    metadata,
    createdAt: FieldValue.serverTimestamp(),
  });
}

exports.ensureCustomerProfile = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    const data = request.data || {};
    const profileRef = db.collection("profiles").doc(auth.uid);
    const profileSnapshot = await profileRef.get();

    if (!profileSnapshot.exists) {
      const user = await getAuth().getUser(auth.uid);
      await profileRef.create({
        ...ownProfile(user.email || "", {
          fullName: data.fullName || user.displayName || "",
          phone: data.phone || "",
        }),
        role: roleOf(auth),
      });
    }

    return { ok: true };
  },
);

exports.submitOrder = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = requireAuth(request);
  requireCustomer(auth);
  const data = request.data || {};
  const items = data.items;

  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new HttpsError(
      "invalid-argument",
      "An order must contain between 1 and 20 menu items.",
    );
  }

  const fulfillment = data.fulfillment;
  const paymentMethod = data.paymentMethod;
  if (!["delivery", "pickup"].includes(fulfillment)) {
    throw new HttpsError("invalid-argument", "Choose delivery or pickup.");
  }
  if (!["cash_on_delivery", "pay_at_cafe"].includes(paymentMethod)) {
    throw new HttpsError(
      "invalid-argument",
      "Only cash on delivery and pay at cafe are currently available.",
    );
  }
  const requestId = requiredText(data.requestId, "Order request ID", 80);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) {
    throw new HttpsError(
      "invalid-argument",
      "The order request ID is invalid. Retry with a new checkout request.",
    );
  }

  const phone = requirePakistaniPhone(data.phone);
  const address =
    fulfillment === "delivery"
      ? requiredText(data.address, "Delivery address", 500)
      : "";
  const notes = optionalText(data.notes, "Order notes", 500);
  const requestedItems = new Map();
  for (const line of items) {
    const itemId = requiredText(line?.itemId, "Menu item", 100);
    const quantity = integerBetween(line?.quantity, "Item quantity", 1, 20);
    requestedItems.set(itemId, (requestedItems.get(itemId) || 0) + quantity);
  }

  if ([...requestedItems.values()].some((quantity) => quantity > 20)) {
    throw new HttpsError(
      "invalid-argument",
      "The quantity of a menu item cannot exceed 20.",
    );
  }

  const couponCode = data.couponCode
    ? requiredText(data.couponCode, "Coupon code", 32).toUpperCase()
    : "";
  const generatedOrderRef = db.collection("orders").doc();
  const orderRequestRef = db
    .collection("orderRequests")
    .doc(`${auth.uid}_${requestId}`);
  const profileRef = db.collection("profiles").doc(auth.uid);
  const settingsRef = db.collection("settings").doc("storefront");
  const menuRefs = [...requestedItems.keys()].map((id) =>
    db.collection("menuItems").doc(id),
  );
  const couponRef = couponCode
    ? db.collection("coupons").doc(couponCode)
    : null;
  const profileSnapshot = await profileRef.get();

  if (!profileSnapshot.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Complete your customer profile before placing an order.",
    );
  }

  const createdOrder = await db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(orderRequestRef);
    if (requestSnapshot.exists) {
      if (requestSnapshot.get("customerId") !== auth.uid) {
        throw new HttpsError(
          "permission-denied",
          "This order request belongs to another customer.",
        );
      }
      const existingOrderRef = db
        .collection("orders")
        .doc(requestSnapshot.get("orderId"));
      const existingOrder = await transaction.get(existingOrderRef);
      if (!existingOrder.exists) {
        throw new HttpsError(
          "failed-precondition",
          "The previous order could not be found. Contact the cafe before retrying.",
        );
      }
      return {
        orderId: existingOrderRef.id,
        status: existingOrder.get("status"),
        currency: existingOrder.get("currency"),
        totalPkr: existingOrder.get("totalPkr"),
        reused: true,
      };
    }

    const [menuSnapshots, settingsSnapshot, couponSnapshot] =
      await Promise.all([
        Promise.all(menuRefs.map((ref) => transaction.get(ref))),
        transaction.get(settingsRef),
        couponRef ? transaction.get(couponRef) : Promise.resolve(null),
      ]);

    const pricedItems = menuSnapshots.map((snapshot, index) => {
      if (!snapshot.exists || snapshot.get("active") !== true) {
        throw new HttpsError(
          "failed-precondition",
          "A menu item is unavailable. Please review your cart.",
        );
      }
      const pricePkr = snapshot.get("pricePkr");
      if (!Number.isSafeInteger(pricePkr) || pricePkr < 0) {
        throw new HttpsError(
          "failed-precondition",
          "A menu item does not have a valid price yet.",
        );
      }
      const quantity = requestedItems.get(menuRefs[index].id);
      return {
        itemId: menuRefs[index].id,
        name: requiredText(snapshot.get("name"), "Menu item name", 100),
        quantity,
        unitPricePkr: pricePkr,
        lineTotalPkr: pricePkr * quantity,
      };
    });

    const subtotalPkr = pricedItems.reduce(
      (sum, item) => sum + item.lineTotalPkr,
      0,
    );
    const deliverySettings = settingsSnapshot.exists
      ? settingsSnapshot.data()
      : {};
    const deliveryFeePkr = calculateDeliveryFee(
      subtotalPkr,
      fulfillment,
      deliverySettings,
    );

    let discountPkr = 0;
    if (couponRef) {
      if (!couponSnapshot.exists || couponSnapshot.get("active") !== true) {
        throw new HttpsError("failed-precondition", "This coupon is unavailable.");
      }

      const coupon = couponSnapshot.data();
      if (
        (coupon.minimumSubtotalPkr || 0) > subtotalPkr ||
        (coupon.expiresAt instanceof Timestamp &&
          coupon.expiresAt.toMillis() < Date.now()) ||
        (Number.isSafeInteger(coupon.maxRedemptions) &&
          (coupon.redemptionCount || 0) >= coupon.maxRedemptions)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This coupon is expired, fully redeemed, or does not meet its minimum spend.",
        );
      }

      if (coupon.discountType === "percent") {
        const percent = integerBetween(
          coupon.discountValue,
          "Coupon percentage",
          1,
          100,
        );
        discountPkr = Math.floor((subtotalPkr * percent) / 100);
      } else if (coupon.discountType === "fixed") {
        discountPkr = integerBetween(
          coupon.discountValue,
          "Coupon discount",
          1,
          1000000,
        );
      } else {
        throw new HttpsError("failed-precondition", "This coupon is not configured.");
      }
      discountPkr = Math.min(discountPkr, subtotalPkr);
      transaction.update(couponRef, {
        redemptionCount: FieldValue.increment(1),
      });
    }

    const customerName = requiredText(
      profileSnapshot.get("fullName"),
      "Customer name",
      100,
    );
    const order = {
      customerId: auth.uid,
      customerName,
      customerEmail: auth.token.email || "",
      phone,
      address,
      fulfillment,
      paymentMethod,
      currency: "PKR",
      items: pricedItems,
      subtotalPkr,
      deliveryFeePkr,
      discountPkr,
      totalPkr: subtotalPkr + deliveryFeePkr - discountPkr,
      couponCode,
      notes,
      status: "received",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const staffOrderRef = db
      .collection("staffOrders")
      .doc(generatedOrderRef.id);
    transaction.create(generatedOrderRef, order);
    transaction.create(staffOrderRef, {
      orderId: generatedOrderRef.id,
      items: pricedItems.map(({ itemId, name, quantity }) => ({
        itemId,
        name,
        quantity,
      })),
      notes,
      fulfillment,
      status: "received",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(orderRequestRef, {
      customerId: auth.uid,
      orderId: generatedOrderRef.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      orderId: generatedOrderRef.id,
      status: order.status,
      currency: order.currency,
      totalPkr: order.totalPkr,
      reused: false,
    };
  });

  if (!createdOrder.reused) {
    await writeAudit("order_created", auth.uid, createdOrder.orderId);
  }
  return {
    orderId: createdOrder.orderId,
    status: createdOrder.status,
    currency: createdOrder.currency,
    totalPkr: createdOrder.totalPkr,
  };
});

exports.updateOrderStatus = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    const { orderId, status, deliveryId } = request.data || {};
    const normalizedOrderId = requiredText(orderId, "Order ID", 100);
    if (!ORDER_STATUSES.includes(status)) {
      throw new HttpsError("invalid-argument", "The order status is invalid.");
    }

    const orderRef = db.collection("orders").doc(normalizedOrderId);
    const staffOrderRef = db
      .collection("staffOrders")
      .doc(normalizedOrderId);
    const role = roleOf(auth);
    const staffRole = staffRoleOf(auth);
    let deliveryRef = null;

    if (staffRole === "delivery") {
      const normalizedDeliveryId = requiredText(
        deliveryId,
        "Delivery assignment",
        100,
      );
      deliveryRef = db.collection("deliveries").doc(normalizedDeliveryId);
    }

    await db.runTransaction(async (transaction) => {
      const [orderSnapshot, staffOrderSnapshot, deliverySnapshot] =
        await Promise.all([
          transaction.get(orderRef),
          transaction.get(staffOrderRef),
          deliveryRef ? transaction.get(deliveryRef) : Promise.resolve(null),
        ]);

      if (!orderSnapshot.exists || !staffOrderSnapshot.exists) {
        throw new HttpsError("not-found", "The order could not be found.");
      }

      const previousStatus = orderSnapshot.get("status");
      let permitted =
        isAdmin(auth) ||
        (role === "manager" && hasManagerPermission(auth, "orders"));
      if (
        role === "customer" &&
        orderSnapshot.get("customerId") === auth.uid &&
        status === "cancelled" &&
        previousStatus === "received"
      ) {
        permitted = true;
      } else if (role === "staff" && staffRole === "kitchen") {
        permitted =
          (previousStatus === "received" && status === "preparing") ||
          (previousStatus === "preparing" && status === "cooking") ||
          (previousStatus === "cooking" && status === "packaging") ||
          (previousStatus === "packaging" &&
            ["ready_for_delivery", "ready_for_pickup"].includes(status));
      } else if (role === "staff" && staffRole === "waiter") {
        permitted =
          orderSnapshot.get("fulfillment") === "pickup" &&
          previousStatus === "ready_for_pickup" &&
          status === "delivered";
      } else if (
        role === "staff" &&
        staffRole === "delivery" &&
        deliverySnapshot &&
        deliverySnapshot.exists &&
        deliverySnapshot.get("orderId") === normalizedOrderId &&
        deliverySnapshot.get("driverId") === auth.uid
      ) {
        permitted =
          (previousStatus === "ready_for_delivery" &&
            status === "out_for_delivery") ||
          (previousStatus === "out_for_delivery" && status === "delivered");
      }

      if (!permitted) {
        throw new HttpsError(
          "permission-denied",
          "You cannot make this order-status change.",
        );
      }

      const update = {
        status,
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(orderRef, update);
      transaction.update(staffOrderRef, update);
      if (deliveryRef && deliverySnapshot && deliverySnapshot.exists) {
        transaction.update(deliveryRef, update);
      }
    });

    await writeAudit("order_status_updated", auth.uid, normalizedOrderId, {
      status,
    });
    return { ok: true, orderId: normalizedOrderId, status };
  },
);

exports.submitReservation = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireCustomer(auth);
    const data = request.data || {};
    const date = requiredText(data.date, "Reservation date", 10);
    const time = requiredText(data.time, "Reservation time", 5);
    requireFutureDate(date, time);

    const guests = integerBetween(data.guests, "Guest count", 1, 20);
    const seating = data.seating || "any";
    if (seating !== "any" && !RESERVATION_SEATING.includes(seating)) {
      throw new HttpsError("invalid-argument", "The seating preference is invalid.");
    }

    const profileSnapshot = await db
      .collection("profiles")
      .doc(auth.uid)
      .get();
    if (!profileSnapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Complete your customer profile before booking.",
      );
    }

    const reservationRef = db.collection("reservations").doc();
    await reservationRef.create({
      customerId: auth.uid,
      customerName: requiredText(
        profileSnapshot.get("fullName"),
        "Customer name",
        100,
      ),
      phone: requirePakistaniPhone(data.phone),
      date,
      time,
      guests,
      seating,
      note: optionalText(data.note, "Reservation note", 500),
      status: "pending",
      tableId: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await writeAudit("reservation_created", auth.uid, reservationRef.id);
    return { reservationId: reservationRef.id, status: "pending" };
  },
);

exports.updateReservation = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    const data = request.data || {};
    const reservationId = requiredText(
      data.reservationId,
      "Reservation ID",
      100,
    );
    const action = data.action;
    if (!["cancel", "approve", "decline", "modify"].includes(action)) {
      throw new HttpsError("invalid-argument", "The reservation action is invalid.");
    }
    const reservationRef = db.collection("reservations").doc(reservationId);
    const role = roleOf(auth);
    let resultStatus = "";

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservationRef);
      if (!snapshot.exists) {
        throw new HttpsError("not-found", "The reservation could not be found.");
      }

      const isCustomerOwner =
        role === "customer" && snapshot.get("customerId") === auth.uid;
      const isReservationStaff =
        isAdmin(auth) ||
        (role === "manager" &&
          hasManagerPermission(auth, "reservations")) ||
        (role === "staff" && staffRoleOf(auth) === "waiter");

      if (action === "cancel") {
        if (
          !isCustomerOwner ||
          !["pending", "approved"].includes(snapshot.get("status"))
        ) {
          throw new HttpsError(
            "permission-denied",
            "This reservation cannot be cancelled by your account.",
          );
        }
        resultStatus = "cancelled";
        transaction.update(reservationRef, {
          status: resultStatus,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      if (action === "modify") {
        const ownerCanModify =
          isCustomerOwner &&
          ["pending", "approved"].includes(snapshot.get("status"));
        if (!isReservationStaff && !ownerCanModify) {
          throw new HttpsError(
            "permission-denied",
            "You cannot modify this reservation.",
          );
        }
        const date = requiredText(data.date, "Reservation date", 10);
        const time = requiredText(data.time, "Reservation time", 5);
        requireFutureDate(date, time);
        const update = {
          date,
          time,
          guests: integerBetween(data.guests, "Guest count", 1, 20),
          seating: data.seating,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (
          update.seating !== "any" &&
          !RESERVATION_SEATING.includes(update.seating)
        ) {
          throw new HttpsError(
            "invalid-argument",
            "The seating preference is invalid.",
          );
        }
        resultStatus = snapshot.get("status");
        transaction.update(reservationRef, update);
        return;
      }

      if (!isReservationStaff) {
        throw new HttpsError(
          "permission-denied",
          "Only a waiter, manager, or admin can manage reservations.",
        );
      }

      if (action === "approve") {
        resultStatus = "approved";
        transaction.update(reservationRef, {
          status: resultStatus,
          tableId: optionalText(data.tableId, "Table ID", 100),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else if (action === "decline") {
        resultStatus = "declined";
        transaction.update(reservationRef, {
          status: resultStatus,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    await writeAudit("reservation_updated", auth.uid, reservationId, {
      action,
      status: resultStatus,
    });
    return { ok: true, reservationId, status: resultStatus };
  },
);

exports.setUserRole = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin"]);

    const targetEmail = requiredText(
      request.data?.email,
      "Account email",
      254,
    ).toLowerCase();
    const role = request.data?.role;
    const staffRole = request.data?.staffRole || "";
    const managerPermissions = request.data?.managerPermissions ?? [];
    if (!isValidRoleAssignment(role, staffRole)) {
      throw new HttpsError(
        "invalid-argument",
        "The role and staff-role assignment are invalid.",
      );
    }
    const ownerGrant = roleOf(auth) === "owner";
    if (!ownerGrant && role !== "staff") {
      throw new HttpsError(
        "permission-denied",
        "Only the owner can grant administrator, manager, HR, or accounts access.",
      );
    }
    if (
      role === "manager" &&
      !isValidManagerPermissions(role, managerPermissions)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Choose valid, non-duplicated manager permissions.",
      );
    }
    if (
      role !== "manager" &&
      (!Array.isArray(managerPermissions) || managerPermissions.length)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Manager permissions may only be assigned to a manager.",
      );
    }
    const user = await getAuth().getUserByEmail(targetEmail);
    const targetUid = user.uid;
    if (!user.emailVerified) {
      throw new HttpsError(
        "failed-precondition",
        "Verify the account email before assigning a portal role.",
      );
    }
    if (targetUid === auth.uid) {
      throw new HttpsError(
        "failed-precondition",
        "Use a separate admin account to change your own access.",
      );
    }
    if (
      !ownerGrant &&
      !["customer", "staff"].includes(user.customClaims?.role || "customer")
    ) {
      throw new HttpsError(
        "permission-denied",
        "Administrators can only assign staff roles to customer or staff accounts.",
      );
    }
    if (user.customClaims?.role === "owner") {
      throw new HttpsError("permission-denied", "Owner access is immutable.");
    }
    const otherClaims = { ...(user.customClaims || {}) };
    delete otherClaims.staffRole;
    delete otherClaims.managerPermissions;
    await getAuth().setCustomUserClaims(targetUid, {
      ...otherClaims,
      role,
      ...(role === "staff" ? { staffRole } : {}),
      ...(role === "manager" ? { managerPermissions } : {}),
    });
    await db
      .collection("profiles")
      .doc(targetUid)
      .set(
        { role, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    const staffDirectoryRef = db.collection("staffDirectory").doc(targetUid);
    if (["staff", "admin", "manager", "hr", "accountant"].includes(role)) {
      const profile = await db.collection("profiles").doc(targetUid).get();
      await staffDirectoryRef.set(
        {
          displayName: profile.get("fullName") || user.displayName || "",
          email: user.email || "",
          phone: profile.get("phone") || "",
          role,
          staffRole: role === "staff" ? staffRole : "",
          managerPermissions: role === "manager" ? managerPermissions : [],
          active: true,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await staffDirectoryRef.delete();
    }
    await writeAudit("user_role_changed", auth.uid, targetUid, {
      role,
      staffRole,
      managerPermissions,
    });

    return {
      ok: true,
      email: user.email || targetEmail,
      role,
      staffRole,
      managerPermissions,
    };
  },
);

exports.getOrganizationRecords = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    const collection = requiredText(
      request.data?.collection,
      "Record group",
      40,
    );
    const access = {
      hiringCandidates: ["admin", "hr"],
      interviews: ["admin", "hr"],
      employeeRecords: ["admin", "hr"],
      onboardingTasks: ["admin", "hr"],
      offboardingTasks: ["admin", "hr"],
      attendance: ["admin", "hr", "manager"],
      customers: ["admin"],
      payrollRecords: ["admin", "hr", "accountant"],
      staffDirectory: ["admin", "hr", "manager"],
      auditLogs: ["admin"],
      orders: ["admin", "manager"],
      reservations: ["admin", "manager"],
      inventory: ["admin", "manager"],
      menuItems: ["admin", "manager"],
    };
    const managerCollectionPermissions = {
      attendance: "attendance",
      staffDirectory: "staffDirectory",
      orders: "orders",
      reservations: "reservations",
      inventory: "inventory",
      menuItems: "menu",
    };
    const allowed =
      Boolean(access[collection]) &&
      (roleOf(auth) === "owner" ||
        (access[collection].includes(roleOf(auth)) &&
          (roleOf(auth) !== "manager" ||
            hasManagerPermission(
              auth,
              managerCollectionPermissions[collection],
            ))));
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "Your account cannot read this business record group.",
      );
    }
    const sourceCollection =
      collection === "customers" ? "profiles" : collection;
    const snapshot = await db.collection(sourceCollection).limit(50).get();
    const records = snapshot.docs.map((document) => {
      if (collection === "customers") {
        return {
          id: document.id,
          fullName: document.get("fullName") || "",
          email: document.get("email") || "",
          phone: document.get("phone") || "",
          rewardPoints: document.get("rewardPoints") || 0,
          membershipLevel: document.get("membershipLevel") || "bronze",
        };
      }
      if (collection === "staffDirectory" && roleOf(auth) === "manager") {
        return {
          id: document.id,
          displayName: document.get("displayName") || "",
          role: document.get("role") || "",
          staffRole: document.get("staffRole") || "",
          active: document.get("active") === true,
        };
      }
      return { id: document.id, ...document.data() };
    });
    return {
      records,
    };
  },
);

exports.upsertHrRecord = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "hr"]);
    const data = request.data || {};
    const recordType = data.recordType;
    const recordId = optionalText(data.recordId, "Record ID", 128);
    const supportedTypes = [
      "hiringCandidates",
      "interviews",
      "employeeRecords",
      "onboardingTasks",
      "offboardingTasks",
    ];
    if (!supportedTypes.includes(recordType)) {
      throw new HttpsError("invalid-argument", "Choose a supported HR record type.");
    }
    const recordRef = recordId
      ? db.collection(recordType).doc(recordId)
      : db.collection(recordType).doc();
    let record;
    if (recordType === "hiringCandidates") {
      const email = requiredText(data.email, "Candidate email", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpsError("invalid-argument", "Enter a valid candidate email.");
      }
      const stage = data.stage || "applied";
      if (!["applied", "screening", "interview", "offer", "hired", "rejected"].includes(stage)) {
        throw new HttpsError("invalid-argument", "The hiring stage is invalid.");
      }
      record = {
        fullName: requiredText(data.fullName, "Candidate name", 100),
        email,
        phone: data.phone ? requirePakistaniPhone(data.phone) : "",
        position: requiredText(data.position, "Position", 100),
        stage,
        notes: optionalText(data.notes, "Hiring notes", 1000),
      };
    } else if (recordType === "interviews") {
      const date = requiredText(data.date, "Interview date", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new HttpsError("invalid-argument", "Interview date is invalid.");
      }
      record = {
        candidateId: requiredText(data.candidateId, "Candidate ID", 128),
        interviewer: requiredText(data.interviewer, "Interviewer", 100),
        date,
        time: requiredText(data.time, "Interview time", 5),
        result: optionalText(data.result, "Interview notes", 1000),
        status: data.status === "completed" ? "completed" : "scheduled",
      };
    } else {
      const employeeUid = requiredText(data.employeeUid, "Employee account UID", 128);
      const employee = await requireEmployeeUser(employeeUid);
      record = {
        employeeUid,
        employeeName:
          optionalText(data.employeeName, "Employee name", 100) ||
          employee.displayName ||
          "",
        employeeEmail: employee.email || "",
        position: requiredText(data.position, "Position", 100),
        date: requiredText(data.date, "Effective date", 10),
        notes: optionalText(data.notes, "HR notes", 1000),
      };
      if (recordType === "employeeRecords") {
        const status = data.status || "active";
        if (!["active", "leave", "offboarding", "inactive"].includes(status)) {
          throw new HttpsError("invalid-argument", "Employee status is invalid.");
        }
        record.status = status;
      } else {
        record.status = data.status === "completed" ? "completed" : "open";
        record.task = requiredText(data.task, "Checklist task", 160);
      }
    }

    await recordRef.set(
      {
        ...record,
        ...(recordId ? {} : { createdAt: FieldValue.serverTimestamp(), createdBy: auth.uid }),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: auth.uid,
      },
      { merge: true },
    );
    await writeAudit("hr_record_updated", auth.uid, recordRef.id, { recordType });
    return { ok: true, recordType, recordId: recordRef.id };
  },
);

exports.upsertPayrollRecord = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "hr", "accountant"]);
    const data = request.data || {};
    const role = roleOf(auth);
    const adminAccess = isAdmin(auth);
    const payrollId = optionalText(data.recordId, "Payroll record ID", 128);
    const payrollRef = payrollId
      ? db.collection("payrollRecords").doc(payrollId)
      : db.collection("payrollRecords").doc();
    const amountsProvided =
      data.grossPayPkr !== undefined ||
      data.deductionsPkr !== undefined ||
      data.benefitsPkr !== undefined;
    let auditEvent = "payroll_review_requested";

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(payrollRef);
      if (role === "hr" || (!existing.exists && adminAccess)) {
        if (role === "hr" && (existing.exists || payrollId)) {
          throw new HttpsError(
            "permission-denied",
            "HR can submit a new payroll draft for review but cannot change payroll records.",
          );
        }
        const grossPayPkr = integerBetween(data.grossPayPkr, "Gross pay in PKR", 0, 100000000);
        const deductionsPkr = integerBetween(
          data.deductionsPkr,
          "Deductions in PKR",
          0,
          grossPayPkr,
        );
        const benefitsPkr = integerBetween(
          data.benefitsPkr ?? 0,
          "Benefits in PKR",
          0,
          10000000,
        );
        const employeeUid = requiredText(data.employeeUid, "Employee UID", 128);
        await requireEmployeeUser(employeeUid);
        const period = requiredText(data.period, "Payroll period", 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
          throw new HttpsError("invalid-argument", "Use a payroll period in YYYY-MM format.");
        }
        transaction.create(payrollRef, {
          employeeUid,
          period,
          grossPayPkr,
          deductionsPkr,
          benefitsPkr,
          netPayPkr: grossPayPkr - deductionsPkr + benefitsPkr,
          currency: "PKR",
          status: "pending_review",
          createdBy: auth.uid,
          updatedBy: auth.uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      if (!existing.exists) {
        throw new HttpsError(
          "failed-precondition",
          "An HR-submitted payroll draft is required before accounting approval.",
        );
      }
      if (amountsProvided || data.employeeUid || data.period) {
        throw new HttpsError(
          "permission-denied",
          "Payroll amounts and periods cannot be edited during approval.",
        );
      }
      const previousStatus = existing.get("status");
      const nextStatus = data.status;
      if (!canTransitionPayrollStatus(role, previousStatus, nextStatus)) {
        throw new HttpsError(
          "permission-denied",
          "Payroll must follow review, approval, and payment steps; only admins can void a record.",
        );
      }
      auditEvent =
        nextStatus === "approved"
          ? "payroll_approved"
          : nextStatus === "paid"
            ? "payroll_marked_paid"
            : "payroll_status_updated";
      transaction.update(payrollRef, {
        status: nextStatus,
        updatedBy: auth.uid,
        updatedAt: FieldValue.serverTimestamp(),
        ...(nextStatus === "approved" ? { approvedBy: auth.uid } : {}),
        ...(nextStatus === "paid" ? { paidBy: auth.uid } : {}),
      });
    });
    await writeAudit(auditEvent, auth.uid, payrollRef.id);
    return { ok: true, payrollId: payrollRef.id };
  },
);

exports.updateCustomerProfile = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    if (roleOf(auth) !== "customer") {
      throw new HttpsError(
        "permission-denied",
        "This profile update is for customer accounts only.",
      );
    }
    const data = request.data || {};
    const addresses = data.addresses || [];
    if (!Array.isArray(addresses) || addresses.length > 5) {
      throw new HttpsError(
        "invalid-argument",
        "Save no more than five delivery addresses.",
      );
    }

    const normalizedAddresses = addresses.map((address) => ({
      label: requiredText(address?.label, "Address label", 40),
      address: requiredText(address?.address, "Address", 300),
      city: optionalText(address?.city, "City", 80) || "Sialkot",
      phone: address?.phone
        ? requirePakistaniPhone(address.phone)
        : "",
    }));
    const photoPath = optionalText(data.photoPath, "Profile photo path", 300);
    if (photoPath && !photoPath.startsWith(`profiles/${auth.uid}/`)) {
      throw new HttpsError(
        "invalid-argument",
        "A profile photo must be stored in your own profile folder.",
      );
    }

    const profileRef = db.collection("profiles").doc(auth.uid);
    await profileRef.set(
      {
        fullName: requiredText(data.fullName, "Full name", 100),
        phone: requirePakistaniPhone(data.phone),
        addresses: normalizedAddresses,
        photoPath,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { ok: true };
  },
);

exports.upsertMenuItem = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "manager"]);
    requireManagerPermission(auth, "menu");
    const data = request.data || {};
    const itemId = requiredText(data.itemId, "Menu item ID", 80).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(itemId)) {
      throw new HttpsError(
        "invalid-argument",
        "The menu item ID can contain only lowercase letters, numbers, and hyphens.",
      );
    }
    const imagePath = optionalText(data.imagePath, "Image path", 300);
    if (imagePath && !imagePath.startsWith("menu/")) {
      throw new HttpsError(
        "invalid-argument",
        "Menu photos must be stored in the menu image folder.",
      );
    }

    const item = {
      name: requiredText(data.name, "Menu item name", 100),
      description: optionalText(data.description, "Description", 500),
      category: requiredText(data.category, "Category", 60),
      pricePkr: integerBetween(data.pricePkr, "Price in PKR", 0, 1000000),
      type: data.type || "veg",
      active:
        data.active === undefined
          ? true
          : data.active === true
            ? true
            : data.active === false
              ? false
              : (() => {
                  throw new HttpsError(
                    "invalid-argument",
                    "Menu availability must be true or false.",
                  );
                })(),
      imagePath,
      updatedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!["veg", "non_veg"].includes(item.type)) {
      throw new HttpsError(
        "invalid-argument",
        "Choose a valid vegetarian or non-vegetarian item type.",
      );
    }

    const menuItemRef = db.collection("menuItems").doc(itemId);
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(menuItemRef);
      transaction.set(
        menuItemRef,
        {
          ...(existing.exists
            ? {}
            : { createdAt: FieldValue.serverTimestamp() }),
          ...item,
        },
        { merge: true },
      );
    });
    await writeAudit("menu_item_updated", auth.uid, itemId, {
      active: item.active,
      pricePkr: item.pricePkr,
    });
    return { ok: true, itemId };
  },
);

exports.upsertCoupon = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin"]);
    const data = request.data || {};
    const code = requiredText(data.code, "Coupon code", 32).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      throw new HttpsError(
        "invalid-argument",
        "Coupon codes can contain only letters, numbers, hyphens, and underscores.",
      );
    }
    const discountType = data.discountType;
    if (!["percent", "fixed"].includes(discountType)) {
      throw new HttpsError(
        "invalid-argument",
        "Choose a percentage or fixed-amount coupon.",
      );
    }
    const discountValue =
      discountType === "percent"
        ? integerBetween(data.discountValue, "Discount percentage", 1, 100)
        : integerBetween(data.discountValue, "Discount in PKR", 1, 1000000);
    const minimumSubtotalPkr = integerBetween(
      data.minimumSubtotalPkr ?? 0,
      "Minimum subtotal in PKR",
      0,
      10000000,
    );
    const maxRedemptions =
      data.maxRedemptions == null
        ? null
        : integerBetween(data.maxRedemptions, "Redemption limit", 1, 1000000);
    let expiresAt = null;
    if (data.expiresAt) {
      const parsedExpiry = new Date(data.expiresAt);
      if (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry <= new Date()) {
        throw new HttpsError(
          "invalid-argument",
          "Coupon expiry must be a valid future date.",
        );
      }
      expiresAt = Timestamp.fromDate(parsedExpiry);
    }
    const active =
      data.active === undefined
        ? true
        : data.active === true
          ? true
          : data.active === false
            ? false
            : (() => {
                throw new HttpsError(
                  "invalid-argument",
                  "Coupon availability must be true or false.",
                );
              })();

    const couponRef = db.collection("coupons").doc(code);
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(couponRef);
      transaction.set(
        couponRef,
        {
          code,
          discountType,
          discountValue,
          minimumSubtotalPkr,
          maxRedemptions,
          expiresAt,
          active,
          updatedBy: auth.uid,
          updatedAt: FieldValue.serverTimestamp(),
          ...(existing.exists
            ? {}
            : {
                redemptionCount: 0,
                createdAt: FieldValue.serverTimestamp(),
              }),
        },
        { merge: true },
      );
    });
    await writeAudit("coupon_updated", auth.uid, code, {
      discountType,
      discountValue,
      active,
    });
    return { ok: true, code };
  },
);

exports.assignDelivery = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "manager"]);
    requireManagerPermission(auth, "orders");
    const orderId = requiredText(request.data?.orderId, "Order ID", 100);
    const driverId = requiredText(request.data?.driverId, "Driver ID", 128);
    const driver = await getAuth().getUser(driverId);

    if (
      driver.customClaims?.role !== "staff" ||
      driver.customClaims?.staffRole !== "delivery"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Assign deliveries to an active delivery staff account.",
      );
    }

    const orderRef = db.collection("orders").doc(orderId);
    const staffOrderRef = db.collection("staffOrders").doc(orderId);
    const deliveryRef = db.collection("deliveries").doc(orderId);
    await db.runTransaction(async (transaction) => {
      const profileRef = db.collection("profiles").doc(driverId);
      const [orderSnapshot, staffOrderSnapshot, profileSnapshot, deliverySnapshot] =
        await Promise.all([
          transaction.get(orderRef),
          transaction.get(staffOrderRef),
          transaction.get(profileRef),
          transaction.get(deliveryRef),
        ]);
      if (!orderSnapshot.exists || !staffOrderSnapshot.exists) {
        throw new HttpsError("not-found", "The order could not be found.");
      }
      if (
        orderSnapshot.get("fulfillment") !== "delivery" ||
        !["packaging", "ready_for_delivery"].includes(
          orderSnapshot.get("status"),
        )
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Only a prepared delivery order can be assigned.",
        );
      }

      const status =
        orderSnapshot.get("status") === "packaging"
          ? "ready_for_delivery"
          : orderSnapshot.get("status");
      const delivery = {
        orderId,
        driverId,
        driverName:
          profileSnapshot.get("fullName") || driver.displayName || "",
        customerId: orderSnapshot.get("customerId"),
        customerName: orderSnapshot.get("customerName"),
        address: orderSnapshot.get("address"),
        phone: orderSnapshot.get("phone"),
        status,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!deliverySnapshot.exists) {
        delivery.createdAt = FieldValue.serverTimestamp();
      }

      transaction.set(deliveryRef, delivery, { merge: true });
      if (status !== orderSnapshot.get("status")) {
        const statusUpdate = {
          status,
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.update(orderRef, statusUpdate);
        transaction.update(staffOrderRef, statusUpdate);
      }
    });

    await writeAudit("delivery_assigned", auth.uid, orderId, { driverId });
    return { ok: true, orderId, driverId };
  },
);

exports.updateInventoryItem = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "manager"]);
    requireManagerPermission(auth, "inventory");
    const data = request.data || {};
    const itemId = requiredText(data.itemId, "Ingredient ID", 100);
    const name = requiredText(data.name, "Ingredient name", 100);
    const unit = requiredText(data.unit, "Stock unit", 24);
    const quantity = integerBetween(data.quantity, "Stock quantity", 0, 1000000);
    const reorderThreshold = integerBetween(
      data.reorderThreshold,
      "Low-stock threshold",
      0,
      1000000,
    );
    const supplier = optionalText(data.supplier, "Supplier", 120);

    await db.collection("inventory").doc(itemId).set(
      {
        name,
        unit,
        quantity,
        reorderThreshold,
        supplier,
        lowStock: quantity <= reorderThreshold,
        updatedBy: auth.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await writeAudit("inventory_item_updated", auth.uid, itemId, {
      quantity,
      lowStock: quantity <= reorderThreshold,
    });
    return { ok: true, itemId, lowStock: quantity <= reorderThreshold };
  },
);

exports.clockAttendance = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["staff", "manager", "admin"]);
    requireManagerPermission(auth, "attendance");

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map((part) => [part.type, part]));
    const localDate = `${date.year.value}-${date.month.value}-${date.day.value}`;
    const attendanceRef = db
      .collection("attendance")
      .doc(`${auth.uid}_${localDate}`);
    const action = request.data?.action;
    if (!["clock_in", "clock_out"].includes(action)) {
      throw new HttpsError("invalid-argument", "Choose clock in or clock out.");
    }

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(attendanceRef);
      if (action === "clock_in") {
        if (snapshot.exists && snapshot.get("clockedOutAt") == null) {
          throw new HttpsError(
            "failed-precondition",
            "You are already clocked in.",
          );
        }
        transaction.set(
          attendanceRef,
          {
            staffId: auth.uid,
            date: localDate,
            clockedInAt: FieldValue.serverTimestamp(),
            clockedOutAt: null,
          },
          { merge: true },
        );
        return;
      }

      if (!snapshot.exists || snapshot.get("clockedOutAt") != null) {
        throw new HttpsError(
          "failed-precondition",
          "Clock in before clocking out.",
        );
      }
      transaction.update(attendanceRef, {
        clockedOutAt: FieldValue.serverTimestamp(),
      });
    });

    await writeAudit("attendance_recorded", auth.uid, attendanceRef.id, {
      action,
    });
    return { ok: true, date: localDate, action };
  },
);

exports.adjustAttendance = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireRole(auth, ["admin", "hr"]);
    const data = request.data || {};
    const staffId = requiredText(data.staffId, "Employee account UID", 128);
    const employee = await requireEmployeeUser(staffId);
    const date = requiredText(data.date, "Attendance date", 10);
    const normalizedDate = new Date(`${date}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(normalizedDate.getTime()) ||
      normalizedDate.toISOString().slice(0, 10) !== date
    ) {
      throw new HttpsError("invalid-argument", "Enter a valid attendance date.");
    }
    const toTimestamp = (value, label) => {
      if (value == null || value === "") return null;
      if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new HttpsError("invalid-argument", `${label} must use 24-hour HH:MM time.`);
      }
      return Timestamp.fromDate(new Date(`${date}T${value}:00+05:00`));
    };
    const clockedInAt = toTimestamp(data.clockIn, "Clock-in time");
    const clockedOutAt = toTimestamp(data.clockOut, "Clock-out time");
    if (!clockedInAt && !clockedOutAt) {
      throw new HttpsError(
        "invalid-argument",
        "Enter a clock-in or clock-out time to save an adjustment.",
      );
    }
    if (
      clockedInAt &&
      clockedOutAt &&
      clockedOutAt.toMillis() <= clockedInAt.toMillis()
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Clock-out time must be later than clock-in on the same date.",
      );
    }
    const attendanceRef = db.collection("attendance").doc(`${staffId}_${date}`);
    const changes = {
      staffId,
      staffName: employee.displayName || employee.email || staffId,
      staffEmail: employee.email || "",
      date,
      ...(clockedInAt ? { clockedInAt } : {}),
      ...(clockedOutAt ? { clockedOutAt } : {}),
      adjustedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    let previousTimes = { clockedInAt: null, clockedOutAt: null };
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(attendanceRef);
      if (existing.exists) {
        previousTimes = {
          clockedInAt: existing.get("clockedInAt") || null,
          clockedOutAt: existing.get("clockedOutAt") || null,
        };
      }
      transaction.set(
        attendanceRef,
        {
          ...changes,
          ...(!existing.exists
            ? { createdAt: FieldValue.serverTimestamp(), createdBy: auth.uid }
            : {}),
        },
        { merge: true },
      );
    });
    await writeAudit("attendance_adjusted", auth.uid, attendanceRef.id, {
      staffId,
      date,
      previousTimes,
      clockIn: data.clockIn || "",
      clockOut: data.clockOut || "",
    });
    return { ok: true, attendanceId: attendanceRef.id };
  },
);

exports.submitSupportTicket = onCall(
  { enforceAppCheck: true },
  async (request) => {
    const auth = requireAuth(request);
    requireCustomer(auth);
    const data = request.data || {};
    const ticketRef = db.collection("supportTickets").doc();
    await ticketRef.create({
      customerId: auth.uid,
      subject: requiredText(data.subject, "Subject", 120),
      message: requiredText(data.message, "Message", 3000),
      category: optionalText(data.category, "Category", 40) || "general",
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ticketId: ticketRef.id, status: "open" };
  },
);
