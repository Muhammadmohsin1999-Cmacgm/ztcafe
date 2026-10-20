const STAFF_ROLES = [
  "kitchen",
  "waiter",
  "delivery",
  "cashier",
  "support",
  "receptionist",
];
const MANAGER_PERMISSIONS = [
  "orders",
  "reservations",
  "menu",
  "inventory",
  "staffDirectory",
  "attendance",
];
const PLATFORM_ROLES = [
  "customer",
  "manager",
  "admin",
  "hr",
  "accountant",
];
const ORDER_STATUSES = [
  "received",
  "preparing",
  "cooking",
  "packaging",
  "ready_for_delivery",
  "out_for_delivery",
  "ready_for_pickup",
  "delivered",
  "cancelled",
];
const RESERVATION_SEATING = ["indoor", "outdoor", "vip"];
const PAYROLL_STATUSES = ["pending_review", "approved", "paid", "void"];

function isPakistaniMobile(value) {
  return (
    typeof value === "string" &&
    /^(?:\+92|0092|0)3\d{9}$/.test(value.replace(/[\s-]/g, ""))
  );
}

function isValidRoleAssignment(role, staffRole) {
  if (role === "staff") return STAFF_ROLES.includes(staffRole);
  return PLATFORM_ROLES.includes(role) && !staffRole;
}

function isValidManagerPermissions(role, permissions) {
  return (
    role === "manager" &&
    Array.isArray(permissions) &&
    permissions.length <= MANAGER_PERMISSIONS.length &&
    new Set(permissions).size === permissions.length &&
    permissions.every((permission) =>
      MANAGER_PERMISSIONS.includes(permission),
    )
  );
}

function hasManagerPermission(role, permissions, permission) {
  return (
    role === "manager" &&
    MANAGER_PERMISSIONS.includes(permission) &&
    Array.isArray(permissions) &&
    permissions.includes(permission)
  );
}

function canTransitionPayrollStatus(role, currentStatus, nextStatus) {
  if (!PAYROLL_STATUSES.includes(nextStatus)) return false;
  if (role === "admin" || role === "owner") return true;
  if (role !== "accountant") return false;
  return (
    (currentStatus === "pending_review" && nextStatus === "approved") ||
    (currentStatus === "approved" && nextStatus === "paid")
  );
}

function calculateDeliveryFee(subtotalPkr, fulfillment, settings = {}) {
  if (fulfillment !== "delivery") return 0;
  const threshold = settings.freeDeliveryThresholdPkr ?? 2500;
  const fee = settings.deliveryFeePkr ?? 150;
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new TypeError("Free-delivery threshold must be a non-negative whole PKR amount.");
  }
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw new TypeError("Delivery fee must be a non-negative whole PKR amount.");
  }
  return subtotalPkr >= threshold ? 0 : fee;
}

module.exports = {
  ORDER_STATUSES,
  MANAGER_PERMISSIONS,
  PAYROLL_STATUSES,
  PLATFORM_ROLES,
  RESERVATION_SEATING,
  STAFF_ROLES,
  calculateDeliveryFee,
  canTransitionPayrollStatus,
  hasManagerPermission,
  isPakistaniMobile,
  isValidManagerPermissions,
  isValidRoleAssignment,
};
