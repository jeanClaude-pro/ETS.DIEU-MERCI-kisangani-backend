const test = require("node:test");
const assert = require("node:assert/strict");
const printRouter = require("./print");

class FakePrinter {
  constructor() {
    this.textLines = [];
    this.cutCount = 0;
  }

  font() { return this; }
  align() { return this; }
  style() { return this; }
  size() { return this; }
  feed() { return this; }
  text(value) { this.textLines.push(String(value)); return this; }
  cut() { this.cutCount += 1; return this; }
}

const savedReceipt = {
  type: "sale",
  reference: "SALE-USB-1",
  date: "09/09/2026 10:30",
  customerName: "Amina",
  customerPhone: "+243000000",
  items: [
    { name: "Article A", quantity: 2, unitPrice: 10, lineTotal: 20, regionCode: "Bbbb" },
    { name: "Article B", quantity: 1, unitPrice: 30, lineTotal: 30, regionCode: "Cnnn" },
  ],
  subtotal: 50,
  discount: 5,
  transportCost: 3,
  tax: 2,
  otherCharges: 1,
  total: 51,
  paymentMethod: "cash",
  salesPerson: "Jean",
  exchangeRate: 2800,
};

test("ESC/POS sale job formats the detailed receipt and compact stub", () => {
  const { normalizeReceiptData, printMainReceipt, printStub, BUSINESS } = printRouter._testing;
  const receipt = normalizeReceiptData(savedReceipt, "sale");
  const printer = new FakePrinter();

  printMainReceipt(printer, receipt);
  printStub(printer, receipt);

  assert.equal(printer.cutCount, 2);
  assert.equal(printer.textLines.filter((value) => value === BUSINESS.name).length, 2);
  assert.ok(printer.textLines.includes("RECU DE VENTE"));
  assert.ok(printer.textLines.includes("SOUCHE VENTE"));
  assert.ok(printer.textLines.some((value) => value.includes("Remise")));
  assert.ok(printer.textLines.some((value) => value.includes("TOTAL FC")));
  assert.ok(printer.textLines.some((value) => value.includes("Bbbb")));
  assert.ok(printer.textLines.some((value) => value.includes("Cnnn")));
});

test("ESC/POS reservation job remains explicitly identified", () => {
  const { normalizeReceiptData, printMainReceipt, printStub } = printRouter._testing;
  const receipt = normalizeReceiptData({
    ...savedReceipt,
    type: "reservation",
    status: "pending",
    reservationDate: "10/09/2026",
    reservationTime: "09:00",
  }, "reservation");
  const printer = new FakePrinter();

  printMainReceipt(printer, receipt);
  printStub(printer, receipt);

  assert.ok(printer.textLines.includes("RECU DE RESERVATION"));
  assert.ok(printer.textLines.includes("SOUCHE RESERVATION"));
  assert.ok(printer.textLines.some((value) => value === "Statut: PENDING"));
  assert.equal(printer.cutCount, 2);
});
