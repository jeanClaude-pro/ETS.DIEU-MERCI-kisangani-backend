const test = require("node:test");
const assert = require("node:assert/strict");
const printRouter = require("./print");

class FakePrinter {
  constructor() {
    this.operations = [];
    this.textLines = [];
    this.cutCalls = [];
  }

  font(value) { this.operations.push(`font:${value}`); return this; }
  align(value) { this.operations.push(`align:${value}`); return this; }
  style(value) { this.operations.push(`style:${value}`); return this; }
  size(width, height) { this.operations.push(`size:${width}x${height}`); return this; }
  encode(value) { this.operations.push(`encode:${value}`); return this; }
  hardware(value) { this.operations.push(`hardware:${value}`); return this; }
  setCharacterCodeTable(value) { this.operations.push(`table:${value}`); return this; }
  text(value) {
    this.textLines.push(String(value));
    this.operations.push(`text:${value}`);
    return this;
  }
  cut(part, feed) {
    this.cutCalls.push({ part, feed });
    this.operations.push(`cut:${feed}`);
    return this;
  }
}

const savedReceipt = {
  type: "sale",
  reference: "SALE-USB-1",
  date: "09/09/2026 10:30",
  customerName: "Amina",
  customerPhone: "+243000000",
  items: [
    {
      name: "Chemise très longue pour femme avec détails brodés élégants",
      quantity: 2,
      unitPrice: 10,
      lineTotal: 20,
      regionCode: "Bbbb",
    },
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

test("ESC/POS receipt is readable, wraps names, and uses minimal cut feed", () => {
  const {
    normalizeReceiptData,
    printMainReceipt,
    BUSINESS,
    PAPER_COLUMNS,
    MINIMUM_CUT_FEED,
    PRINTER_ENCODING,
  } = printRouter._testing;
  const receipt = normalizeReceiptData(savedReceipt, "sale");
  const printer = new FakePrinter();

  printMainReceipt(printer, receipt);

  assert.equal(printer.cutCalls.length, 1);
  assert.deepEqual(printer.cutCalls[0], { part: false, feed: MINIMUM_CUT_FEED });
  assert.equal(MINIMUM_CUT_FEED, 1);
  assert.ok(printer.operations.includes(`encode:${PRINTER_ENCODING}`));
  assert.ok(printer.operations.includes("hardware:init"));
  assert.ok(printer.textLines.includes(BUSINESS.name));
  assert.ok(printer.textLines.includes("REÇU DE VENTE"));
  assert.ok(printer.textLines.some((value) => value.includes("Référence")));
  assert.ok(printer.textLines.some((value) => value.includes("Remise")));
  assert.ok(printer.textLines.some((value) => value.includes("TOTAL FC")));
  assert.equal(printer.textLines.some((value) => value.includes("Bbbb")), false);
  assert.equal(printer.textLines.some((value) => value.includes("Total article FC")), false);
  assert.ok(printer.textLines.every((value) => value.length <= PAPER_COLUMNS));
  assert.equal(printer.operations.some((value) => value.startsWith("feed:")), false);
});

test("ESC/POS sends and flushes the full receipt before building the stub", async () => {
  const { normalizeReceiptData, sendReceiptThenStub } = printRouter._testing;
  const receipt = normalizeReceiptData(savedReceipt, "sale");
  const printer = new FakePrinter();
  const flushCuts = [];

  const printed = await sendReceiptThenStub(printer, receipt, async (activePrinter) => {
    flushCuts.push(activePrinter.cutCalls.length);
    activePrinter.operations.push(`flush:${activePrinter.cutCalls.length}`);
  });

  assert.deepEqual(printed, ["receipt", "stub"]);
  assert.deepEqual(flushCuts, [1, 2]);
  const receiptTitle = printer.operations.indexOf("text:REÇU DE VENTE");
  const firstCut = printer.operations.indexOf("cut:1");
  const firstFlush = printer.operations.indexOf("flush:1");
  const stubTitle = printer.operations.indexOf("text:SOUCHE DE VENTE");
  const secondFlush = printer.operations.indexOf("flush:2");
  assert.ok(receiptTitle < firstCut);
  assert.ok(firstCut < firstFlush);
  assert.ok(firstFlush < stubTitle);
  assert.ok(stubTitle < secondFlush);
  assert.ok(printer.textLines.includes("Statut : COMPLETED"));
  assert.ok(printer.textLines.includes("ARTICLES ACHETÉS"));
  assert.ok(printer.textLines.includes("ARTICLES VENDUS"));
  assert.ok(printer.textLines.includes("SOUCHE DE CAISSE"));
  assert.ok(printer.textLines.some((value) => value.startsWith("2 x 10.00 USD")));
});

test("empty and malformed payloads are rejected before a printer job", () => {
  const { normalizeReceiptData, isValidReceiptData } = printRouter._testing;
  assert.equal(isValidReceiptData(normalizeReceiptData({})), false);
  assert.equal(isValidReceiptData(normalizeReceiptData({ ...savedReceipt, reference: "" })), false);
  assert.equal(isValidReceiptData(normalizeReceiptData({
    ...savedReceipt,
    items: [{ name: "Article", quantity: 0, unitPrice: 10, lineTotal: 0 }],
  })), false);
  assert.equal(isValidReceiptData(normalizeReceiptData(savedReceipt)), true);
});

test("every authenticated role can reprint without receiving sale mutation rights", () => {
  const { canReprintSale } = printRouter._testing;
  for (const role of ["admin", "manager", "inventory_manager", "cashier_supervisor", "staff"]) {
    assert.equal(canReprintSale({ _id: "user-id", role }), true);
  }
  assert.equal(canReprintSale(null), false);
});

test("committed Sale documents normalize their nested snapshots", () => {
  const { normalizeReceiptData } = printRouter._testing;
  const receipt = normalizeReceiptData({
    _id: "database-id",
    saleId: "SALE-SAVED",
    createdAt: "2026-09-09T08:30:00.000Z",
    customer: { name: "Amina", phone: "+243000000" },
    items: [{ name: "Robe", unit: "pcs", quantity: 2, price: 10, total: 20 }],
    subtotal: 20,
    total: 20,
    paymentMethod: "cash",
    salesPerson: "Jean",
    exchangeRateSnapshot: { rate: 2800 },
  });

  assert.equal(receipt.reference, "SALE-SAVED");
  assert.equal(receipt.customerName, "Amina");
  assert.equal(receipt.items[0].unit, "pcs");
  assert.equal(receipt.exchangeRate, 2800);
});

test("a stub transfer failure reports that only the receipt was printed", async () => {
  const { normalizeReceiptData, sendReceiptThenStub } = printRouter._testing;
  const receipt = normalizeReceiptData(savedReceipt, "sale");
  const printer = new FakePrinter();
  let flushCount = 0;

  await assert.rejects(async () => {
    try {
      await sendReceiptThenStub(printer, receipt, async () => {
        flushCount += 1;
        if (flushCount === 2) throw new Error("USB transfer failed");
      });
    } catch (error) {
      assert.deepEqual(error.printedDocuments, ["receipt"]);
      throw error;
    }
  }, /USB transfer failed/);
});

test("ESC/POS reservation receipt and stub retain French labels and reset state", () => {
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

  assert.ok(printer.textLines.includes("REÇU DE RÉSERVATION"));
  assert.ok(printer.textLines.includes("SOUCHE DE RÉSERVATION"));
  assert.ok(printer.textLines.some((value) => value === "Statut : PENDING"));
  assert.equal(printer.cutCalls.length, 2);
  assert.equal(printer.operations.filter((value) => value === "style:normal").length >= 2, true);
});
