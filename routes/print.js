const express = require("express");
const escpos = require("escpos");

escpos.USB = require("escpos-usb");
const router = express.Router();

const BUSINESS = Object.freeze({
  name: "Boutique C'EST DIEU QUI PARTAGE",
  address: "Av du 1er Janvier No13, C. Makiso, Kisangani",
  registration: "RCCM/KIS : 22-A-267",
});

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const textValue = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
const money = (value) => `${numberValue(value).toFixed(2)} USD`;
const line = "------------------------------------------";

function normalizeReceiptData(receiptData = {}, requestedType = "sale") {
  const items = Array.isArray(receiptData.items)
    ? receiptData.items.map((item) => {
        const quantity = numberValue(item.quantity);
        const unitPrice = numberValue(item.unitPrice ?? item.price);
        return {
          name: textValue(item.name) || "Article",
          quantity,
          unitPrice,
          lineTotal: numberValue(item.lineTotal ?? item.total ?? item.subtotal) || quantity * unitPrice,
          regionCode: textValue(item.regionCode),
        };
      })
    : [];
  const type = requestedType === "reservation" || receiptData.type === "reservation"
    ? "reservation"
    : "sale";

  return {
    type,
    status: textValue(receiptData.status) || (type === "reservation" ? "pending" : "completed"),
    reference: textValue(receiptData.reference ?? receiptData.receiptNumber ?? receiptData.stubNumber) || "N/A",
    date: textValue(receiptData.date) || new Date().toLocaleString("fr-FR"),
    customerName: textValue(receiptData.customerName) || "Walk-in Customer",
    customerPhone: textValue(receiptData.customerPhone),
    items,
    subtotal: numberValue(receiptData.subtotal) || items.reduce((sum, item) => sum + item.lineTotal, 0),
    discount: numberValue(receiptData.discount),
    tax: numberValue(receiptData.tax),
    transportCost: numberValue(receiptData.transportCost),
    otherCharges: numberValue(receiptData.otherCharges),
    total: numberValue(receiptData.total),
    paymentMethod: textValue(receiptData.paymentMethod) || "cash",
    salesPerson: textValue(receiptData.salesPerson) || "Agent",
    exchangeRate: numberValue(receiptData.exchangeRate),
    reservationDate: textValue(receiptData.reservationDate),
    reservationTime: textValue(receiptData.reservationTime),
    notes: textValue(receiptData.notes),
  };
}

function getPrinter() {
  try {
    const device = new escpos.USB();
    return new escpos.Printer(device);
  } catch (error) {
    console.error("No USB printer found:", error);
    return null;
  }
}

function openDevice(device) {
  return new Promise((resolve, reject) => {
    device.open((error) => error ? reject(error) : resolve());
  });
}

function closePrinter(printer) {
  return new Promise((resolve) => printer.close(resolve));
}

function printBusinessHeader(printer) {
  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(BUSINESS.name)
    .style("normal")
    .text(BUSINESS.address)
    .text(BUSINESS.registration)
    .text(line);
}

function printMainReceipt(printer, receipt) {
  const isReservation = receipt.type === "reservation";
  printBusinessHeader(printer);
  printer
    .style("b")
    .text(isReservation ? "RECU DE RESERVATION" : "RECU DE VENTE")
    .style("normal")
    .align("lt")
    .text(`Reference: ${receipt.reference}`)
    .text(`Date: ${receipt.date}`);

  if (isReservation) {
    printer.text(`Statut: ${receipt.status.toUpperCase()}`);
    if (receipt.reservationDate || receipt.reservationTime) {
      printer.text(`Retrait: ${[receipt.reservationDate, receipt.reservationTime].filter(Boolean).join(" a ")}`);
    }
  }

  printer.text(line).text(`Client: ${receipt.customerName}`);
  if (receipt.customerPhone) printer.text(`Tel: ${receipt.customerPhone}`);
  printer.text(line).style("b").text("ARTICLES").style("normal");

  for (const item of receipt.items) {
    const region = item.regionCode ? ` (${item.regionCode})` : "";
    printer
      .text(`${item.name}${region}`)
      .text(`  ${item.quantity} x ${money(item.unitPrice)} = ${money(item.lineTotal)}`);
  }

  printer.text(line).text(`Sous-total: ${money(receipt.subtotal)}`);
  if (receipt.discount > 0) printer.text(`Remise: -${money(receipt.discount)}`);
  if (receipt.transportCost > 0) printer.text(`Transport: +${money(receipt.transportCost)}`);
  if (receipt.tax > 0) printer.text(`Taxes: +${money(receipt.tax)}`);
  if (receipt.otherCharges > 0) printer.text(`Autres frais: +${money(receipt.otherCharges)}`);
  printer.style("b").text(`TOTAL: ${money(receipt.total)}`).style("normal");
  if (receipt.exchangeRate > 0) {
    printer
      .text(`TOTAL FC: ${Math.round(receipt.total * receipt.exchangeRate)} FC`)
      .text(`Taux: 1 USD = ${Math.round(receipt.exchangeRate)} FC`);
  }
  printer
    .text(`Paiement: ${receipt.paymentMethod.toUpperCase()}`)
    .text(`Agent: ${receipt.salesPerson}`);
  if (isReservation && receipt.notes) printer.text(`Notes: ${receipt.notes}`);
  printer
    .align("ct")
    .feed(1)
    .text("Merci pour votre confiance.")
    .text("Marchandises vendues non reprises,")
    .text("non echangees.")
    .feed(2)
    .cut();
}

function printStub(printer, receipt) {
  const isReservation = receipt.type === "reservation";
  printer
    .align("ct")
    .style("b")
    .text(BUSINESS.name)
    .text(isReservation ? "SOUCHE RESERVATION" : "SOUCHE VENTE")
    .style("normal")
    .align("lt")
    .text(`Reference: ${receipt.reference}`)
    .text(`Date: ${receipt.date}`)
    .text(`Client: ${receipt.customerName}`);
  if (isReservation && (receipt.reservationDate || receipt.reservationTime)) {
    printer.text(`Retrait: ${[receipt.reservationDate, receipt.reservationTime].filter(Boolean).join(" a ")}`);
  }
  printer
    .text(`Paiement: ${receipt.paymentMethod.toUpperCase()}`)
    .style("b")
    .text(`TOTAL: ${money(receipt.total)}`)
    .style("normal")
    .text(`Agent: ${receipt.salesPerson}`)
    .feed(2)
    .cut();
}

async function handleCombinedPrint(req, res) {
  const printer = getPrinter();
  if (!printer) return res.status(503).json({ error: "No printer found" });

  let deviceOpened = false;
  try {
    const receipt = normalizeReceiptData(req.body?.receiptData, req.body?.type);
    if (!receipt.items.length) {
      return res.status(400).json({ error: "Receipt items are required" });
    }
    await openDevice(printer.device);
    deviceOpened = true;
    printMainReceipt(printer, receipt);
    printStub(printer, receipt);
    await closePrinter(printer);
    deviceOpened = false;
    return res.json({
      success: true,
      message: "Receipt and stub printed successfully",
      documents: ["receipt", "stub"],
    });
  } catch (error) {
    console.error("Combined receipt printing failed:", error);
    if (deviceOpened) {
      try {
        await closePrinter(printer);
      } catch (closeError) {
        console.error("Printer cleanup failed:", closeError);
      }
    }
    return res.status(500).json({ error: "Receipt and stub printing failed" });
  }
}

// /receipt and /stub remain compatibility aliases, but every endpoint prints
// the complete pair so no caller can accidentally output only half a sale job.
router.post(["/sale", "/receipt", "/stub"], handleCombinedPrint);

router._testing = { normalizeReceiptData, printMainReceipt, printStub, BUSINESS };

module.exports = router;
