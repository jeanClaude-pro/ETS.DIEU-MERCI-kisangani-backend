const express = require("express");
const escpos = require("escpos");
const authMiddleware = require("../middleware/auth");
const Sale = require("../models/Sale");

escpos.USB = require("escpos-usb");
const router = express.Router();

// The existing browser layout and 42-character separator identify this as the
// project's 80 mm path. Forty-two Font-A columns leave conservative margins.
const PAPER_COLUMNS = 42;
const MINIMUM_CUT_FEED = 1;
const PRINTER_ENCODING = "CP850";
const CP850_CHARACTER_TABLE = 2;

const BUSINESS = Object.freeze({
  name: "Boutique C'EST DIEU QUI PARTAGE",
  address: "Av du 1er Janvier N°13, C. Makiso, Kisangani",
  phone: "+243 839 336 794",
  registration: "RCCM/KIS : 22-A-267",
  thankYou: "Merci pour votre confiance.",
  salesNotice: "Marchandises vendues non reprises, non échangées.",
});

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const textValue = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
const money = (value) => `${numberValue(value).toFixed(2)} USD`;
const line = "-".repeat(PAPER_COLUMNS);

function normalizeReceiptData(receiptData = {}, requestedType = "sale") {
  const items = Array.isArray(receiptData.items)
    ? receiptData.items.map((item) => {
        const quantity = numberValue(item.quantity);
        const unitPrice = numberValue(item.unitPrice ?? item.price);
        return {
          name: textValue(item.name) || "Article",
          unit: textValue(item.unit),
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
  const snapshotRate = numberValue(receiptData.exchangeRateSnapshot?.rate);
  const rawDate = receiptData.createdAt ?? receiptData.date;
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const formattedDate = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toLocaleString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lubumbashi",
      })
    : textValue(rawDate) || new Date().toLocaleString("fr-FR", { timeZone: "Africa/Lubumbashi" });

  return {
    type,
    status: textValue(receiptData.status) || (type === "reservation" ? "pending" : "completed"),
    reference: textValue(receiptData.saleId ?? receiptData.reference ?? receiptData.receiptNumber ?? receiptData.stubNumber ?? receiptData._id) || "N/A",
    date: formattedDate,
    customerName: textValue(receiptData.customer?.name ?? receiptData.customerName) || "Walk-in Customer",
    customerPhone: textValue(receiptData.customer?.phone ?? receiptData.customerPhone),
    items,
    subtotal: numberValue(receiptData.subtotal) || items.reduce((sum, item) => sum + item.lineTotal, 0),
    discount: numberValue(receiptData.discount),
    tax: numberValue(receiptData.tax),
    transportCost: numberValue(receiptData.transportCost),
    otherCharges: numberValue(receiptData.otherCharges),
    total: numberValue(receiptData.total),
    paymentMethod: textValue(receiptData.paymentMethod) || "cash",
    salesPerson: textValue(receiptData.salesPerson) || "Agent",
    exchangeRate: snapshotRate || numberValue(receiptData.exchangeRate),
    reservationDate: textValue(receiptData.reservationDate),
    reservationTime: textValue(receiptData.reservationTime),
    notes: textValue(receiptData.notes),
  };
}

function isValidReceiptData(receipt) {
  const invalidItem = receipt.items.some((item) =>
    !item.name || !Number.isFinite(item.quantity) || item.quantity <= 0 ||
    !Number.isFinite(item.unitPrice) || item.unitPrice < 0 ||
    !Number.isFinite(item.lineTotal) || item.lineTotal < 0);
  return receipt.items.length > 0 && receipt.reference !== "N/A" && !invalidItem &&
    Number.isFinite(receipt.total) && receipt.total >= 0;
}

function wrapText(value, width = PAPER_COLUMNS) {
  const text = textValue(value);
  if (!text) return [];
  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(" ", width);
    if (splitAt <= 0) splitAt = width;
    lines.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function columns(left, right, width = PAPER_COLUMNS) {
  const safeLeft = textValue(left);
  const safeRight = textValue(right);
  const availableLeft = Math.max(1, width - safeRight.length - 1);
  const clippedLeft = safeLeft.length > availableLeft
    ? `${safeLeft.slice(0, Math.max(1, availableLeft - 1))}…`
    : safeLeft;
  return `${clippedLeft}${" ".repeat(Math.max(1, width - clippedLeft.length - safeRight.length))}${safeRight}`;
}

function getPrinter() {
  try {
    const device = new escpos.USB();
    return new escpos.Printer(device, { encoding: PRINTER_ENCODING, width: PAPER_COLUMNS });
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

function flushPrinter(printer) {
  return new Promise((resolve, reject) => {
    printer.flush((error) => error ? reject(error) : resolve());
  });
}

function closeDevice(printer) {
  return new Promise((resolve, reject) => {
    printer.adapter.close((error) => error ? reject(error) : resolve());
  });
}

function initializeDocument(printer) {
  printer
    .encode(PRINTER_ENCODING)
    .setCharacterCodeTable(CP850_CHARACTER_TABLE)
    .font("a")
    .size(1, 1)
    .style("normal")
    .align("lt");
}

function finishDocument(printer) {
  // escpos.cut() adds its own feed. Passing 1 avoids its three-line default
  // and leaves only the minimum clearance needed to move content past a cutter.
  printer
    .style("normal")
    .size(1, 1)
    .font("a")
    .align("lt")
    .cut(false, MINIMUM_CUT_FEED);
}

function printBusinessHeader(printer) {
  initializeDocument(printer);
  printer
    .align("ct")
    .style("b")
    .text(BUSINESS.name)
    .style("normal");
  for (const addressLine of wrapText(BUSINESS.address)) printer.text(addressLine);
  printer.text(`Tél. : ${BUSINESS.phone}`).text(BUSINESS.registration).text(line);
}

function printMainReceipt(printer, receipt) {
  const isReservation = receipt.type === "reservation";
  printBusinessHeader(printer);
  printer
    .style("b")
    .text(isReservation ? "REÇU DE RÉSERVATION" : "REÇU DE VENTE")
    .style("normal")
    .align("lt")
    .text(`Référence : ${receipt.reference}`)
    .text(`Date : ${receipt.date}`)
    .text(`Statut : ${receipt.status.toUpperCase()}`);

  if (isReservation) {
    if (receipt.reservationDate || receipt.reservationTime) {
      printer.text(`Retrait : ${[receipt.reservationDate, receipt.reservationTime].filter(Boolean).join(" à ")}`);
    }
  }

  printer.text(line);
  for (const customerLine of wrapText(`Client : ${receipt.customerName}`)) printer.text(customerLine);
  if (receipt.customerPhone) {
    for (const phoneLine of wrapText(`Tél. : ${receipt.customerPhone}`)) printer.text(phoneLine);
  }
  printer.text(line).align("ct").style("b").text("ARTICLES ACHETÉS").style("normal").align("lt");

  for (const item of receipt.items) {
    const label = `${item.name}${item.regionCode ? ` (${item.regionCode})` : ""}`;
    for (const nameLine of wrapText(label)) printer.text(nameLine);
    const quantityLabel = `${item.quantity}${item.unit ? ` ${item.unit}` : ""} x ${money(item.unitPrice)}`;
    printer.text(columns(quantityLabel, money(item.lineTotal)));
    if (receipt.exchangeRate > 0) {
      printer
        .text(columns("PU FC", `${Math.round(item.unitPrice * receipt.exchangeRate)} FC`))
        .style("b")
        .text(columns("Total article FC", `${Math.round(item.lineTotal * receipt.exchangeRate)} FC`))
        .style("normal");
    }
  }

  printer.text(line).text(columns("Sous-total", money(receipt.subtotal)));
  if (receipt.discount > 0) printer.text(columns("Remise", `-${money(receipt.discount)}`));
  if (receipt.transportCost > 0) printer.text(columns("Transport", `+${money(receipt.transportCost)}`));
  if (receipt.tax > 0) printer.text(columns("Taxes", `+${money(receipt.tax)}`));
  if (receipt.otherCharges > 0) printer.text(columns("Autres frais", `+${money(receipt.otherCharges)}`));
  printer.style("b").text(columns("TOTAL", money(receipt.total))).style("normal");
  if (receipt.exchangeRate > 0) {
    printer
      .text(columns("TOTAL FC", `${Math.round(receipt.total * receipt.exchangeRate)} FC`))
      .text(`Taux enregistré : 1 USD = ${Math.round(receipt.exchangeRate)} FC`);
  }
  printer.text(`Paiement : ${receipt.paymentMethod.toUpperCase()}`);
  for (const agentLine of wrapText(`Agent de vente : ${receipt.salesPerson}`)) printer.text(agentLine);
  if (isReservation && receipt.notes) {
    for (const noteLine of wrapText(`Notes : ${receipt.notes}`)) printer.text(noteLine);
  }
  printer
    .align("ct")
    .style("b")
    .text(BUSINESS.thankYou)
    .style("normal");
  for (const noticeLine of wrapText(BUSINESS.salesNotice)) printer.text(noticeLine);
  finishDocument(printer);
  return printer;
}

function printStub(printer, receipt) {
  const isReservation = receipt.type === "reservation";
  initializeDocument(printer);
  printer
    .align("ct")
    .style("b")
    .text(BUSINESS.name)
    .text(isReservation ? "SOUCHE DE RÉSERVATION" : "SOUCHE DE VENTE")
    .style("normal")
    .align("lt");
  for (const value of [
    `Référence : ${receipt.reference}`,
    `Date : ${receipt.date}`,
    `Client : ${receipt.customerName}`,
    `Statut : ${receipt.status.toUpperCase()}`,
  ]) {
    for (const metadataLine of wrapText(value)) printer.text(metadataLine);
  }
  if (isReservation && (receipt.reservationDate || receipt.reservationTime)) {
    printer.text(`Retrait : ${[receipt.reservationDate, receipt.reservationTime].filter(Boolean).join(" à ")}`);
  }
  printer.text(line).align("ct").style("b").text("ARTICLES VENDUS").style("normal").align("lt");
  for (const item of receipt.items) {
    for (const nameLine of wrapText(item.name)) printer.text(nameLine);
    printer.text(columns(`${item.quantity}${item.unit ? ` ${item.unit}` : ""} x ${money(item.unitPrice)}`, money(item.lineTotal)));
    if (receipt.exchangeRate > 0) {
      printer.text(columns("Total FC", `${Math.round(item.lineTotal * receipt.exchangeRate)} FC`));
    }
  }
  printer
    .text(line)
    .text(`Paiement : ${receipt.paymentMethod.toUpperCase()}`)
    .style("b")
    .text(columns("TOTAL", money(receipt.total)))
    .style("normal");
  for (const agentLine of wrapText(`Agent de vente : ${receipt.salesPerson}`)) printer.text(agentLine);
  printer.align("ct")
    .style("b")
    .text("SOUCHE DE CAISSE")
    .style("normal")
    .text("À conserver");
  finishDocument(printer);
  return printer;
}

async function sendReceiptThenStub(printer, receipt, flush = flushPrinter) {
  const printedDocuments = [];
  try {
    printMainReceipt(printer, receipt);
    await flush(printer);
    printedDocuments.push("receipt");

    printStub(printer, receipt);
    await flush(printer);
    printedDocuments.push("stub");
    return printedDocuments;
  } catch (error) {
    error.printedDocuments = [...printedDocuments];
    throw error;
  }
}

async function handleCombinedPrint(req, res) {
  let deviceOpened = false;
  let printedDocuments = [];
  let printer = null;
  try {
    const savedSaleId = textValue(req.body?.savedSaleId);
    let source = req.body?.receiptData;
    if (savedSaleId) {
      const savedSale = /^[a-f\d]{24}$/i.test(savedSaleId)
        ? await Sale.findById(savedSaleId).lean()
        : await Sale.findOne({ saleId: savedSaleId }).lean();
      if (!savedSale) {
        return res.status(404).json({
          success: false,
          code: "SAVED_SALE_NOT_FOUND",
          error: "Saved sale not found",
          printedDocuments,
        });
      }
      source = savedSale;
    }
    const receipt = normalizeReceiptData(source, req.body?.type);
    if (!isValidReceiptData(receipt)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_RECEIPT_DATA",
        error: "Valid saved sale data is required",
        printedDocuments,
      });
    }
    printer = getPrinter();
    if (!printer) {
      return res.status(503).json({
        success: false,
        code: "DIRECT_PRINTER_UNAVAILABLE",
        error: "No printer found",
        printedDocuments,
      });
    }
    await openDevice(printer.device);
    deviceOpened = true;
    printedDocuments = await sendReceiptThenStub(printer, receipt);
    await closeDevice(printer);
    deviceOpened = false;
    return res.json({
      success: true,
      code: "DIRECT_PRINT_COMPLETE",
      message: "Receipt and stub printed successfully",
      documents: printedDocuments,
      printedDocuments,
    });
  } catch (error) {
    printedDocuments = error.printedDocuments || printedDocuments;
    console.error("Combined receipt printing failed:", error);
    if (deviceOpened && printer) {
      try {
        await closeDevice(printer);
      } catch (closeError) {
        console.error("Printer cleanup failed:", closeError);
      }
    }
    return res.status(500).json({
      success: false,
      code: printedDocuments.includes("receipt")
        ? "DIRECT_STUB_PRINT_FAILED"
        : "DIRECT_RECEIPT_PRINT_FAILED",
      error: "Receipt and stub printing failed",
      printedDocuments,
    });
  }
}

// Existing aliases remain compatible, but triggering the physical printer now
// requires the same valid JWT as the sale and reprint screens.
router.post(["/sale", "/receipt", "/stub"], authMiddleware, handleCombinedPrint);

router._testing = {
  normalizeReceiptData,
  isValidReceiptData,
  wrapText,
  columns,
  printMainReceipt,
  printStub,
  sendReceiptThenStub,
  BUSINESS,
  PAPER_COLUMNS,
  MINIMUM_CUT_FEED,
  PRINTER_ENCODING,
};

module.exports = router;
