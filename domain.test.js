const assert = require("node:assert/strict");
const test = require("node:test");
const {
  canTransitionPayrollStatus,
  calculateDeliveryFee,
  hasManagerPermission,
  isPakistaniMobile,
  isValidRoleAssignment,
  isValidManagerPermissions,
} = require("../src/domain");

test("accepts common Pakistani mobile number formats", () => {
  assert.equal(isPakistaniMobile("03001234567"), true);
  assert.equal(isPakistaniMobile("+923001234567"), true);
  assert.equal(isPakistaniMobile("00923001234567"), true);
  assert.equal(isPakistaniMobile("+92 300-1234567"), true);
  assert.equal(isPakistaniMobile("02001234567"), false);
  assert.equal(isPakistaniMobile("0300123456"), false);
  assert.equal(isPakistaniMobile(null), false);
});

test("only known staff and platform roles can be assigned", () => {
  assert.equal(isValidRoleAssignment("staff", "kitchen"), true);
  assert.equal(isValidRoleAssignment("staff", "delivery"), true);
  assert.equal(isValidRoleAssignment("staff", "receptionist"), true);
  assert.equal(isValidRoleAssignment("staff", "owner"), false);
  assert.equal(isValidRoleAssignment("admin", ""), true);
  assert.equal(isValidRoleAssignment("hr", ""), true);
  assert.equal(isValidRoleAssignment("accountant", ""), true);
  assert.equal(isValidRoleAssignment("manager", "waiter"), false);
  assert.equal(isValidRoleAssignment("hr", "kitchen"), false);
  assert.equal(isValidRoleAssignment("owner", ""), false);
  assert.equal(isValidRoleAssignment("operationsLead", ""), false);
});

test("manager permissions are explicit, unique, and role-specific", () => {
  assert.equal(
    isValidManagerPermissions("manager", ["orders", "inventory"]),
    true,
  );
  assert.equal(isValidManagerPermissions("manager", []), true);
  assert.equal(isValidManagerPermissions("manager", ["payroll"]), false);
  assert.equal(
    isValidManagerPermissions("manager", ["orders", "orders"]),
    false,
  );
  assert.equal(isValidManagerPermissions("admin", ["orders"]), false);
  assert.equal(isValidManagerPermissions("manager", "orders"), false);
  assert.equal(hasManagerPermission("manager", ["orders"], "orders"), true);
  assert.equal(hasManagerPermission("manager", [], "orders"), false);
  assert.equal(hasManagerPermission("hr", ["orders"], "orders"), false);
  assert.equal(hasManagerPermission("manager", ["payroll"], "payroll"), false);
});

test("payroll approvals follow the accountant review sequence", () => {
  assert.equal(
    canTransitionPayrollStatus("accountant", "pending_review", "approved"),
    true,
  );
  assert.equal(
    canTransitionPayrollStatus("accountant", "approved", "paid"),
    true,
  );
  assert.equal(
    canTransitionPayrollStatus("accountant", "pending_review", "paid"),
    false,
  );
  assert.equal(
    canTransitionPayrollStatus("accountant", "approved", "void"),
    false,
  );
  assert.equal(
    canTransitionPayrollStatus("hr", "pending_review", "approved"),
    false,
  );
  assert.equal(canTransitionPayrollStatus("admin", "paid", "void"), true);
  assert.equal(canTransitionPayrollStatus("owner", "paid", "void"), true);
});

test("calculates delivery in whole PKR and honors configured thresholds", () => {
  assert.equal(calculateDeliveryFee(1000, "delivery"), 150);
  assert.equal(calculateDeliveryFee(2500, "delivery"), 0);
  assert.equal(calculateDeliveryFee(1000, "pickup"), 0);
  assert.equal(
    calculateDeliveryFee(1000, "delivery", {
      deliveryFeePkr: 0,
      freeDeliveryThresholdPkr: 3000,
    }),
    0,
  );
  assert.throws(
    () =>
      calculateDeliveryFee(1000, "delivery", {
        deliveryFeePkr: -1,
      }),
    TypeError,
  );
});
