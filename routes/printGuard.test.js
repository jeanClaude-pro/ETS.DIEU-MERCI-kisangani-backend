const test = require("node:test");
const assert = require("node:assert/strict");
const printRouter = require("./print");

test("direct printing refuses caller-supplied receipt content without a saved sale", async () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  const forged = {
    reference: "FAKE-1",
    total: 999,
    items: [{ name: "Forged item", quantity: 1, unitPrice: 999, lineTotal: 999 }],
  };
  await printRouter._testing.handleCombinedPrint({ body: { receiptData: forged } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "SAVED_SALE_REQUIRED");
  // The client may fall back to its own browser print.
  assert.equal(res.body.fallbackSafe, true);
});
