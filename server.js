// server.js — PurPort deploy entrypoint
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeScreenshot } from "./lib/vision.js";
import { getPrices } from "./lib/pricing.js";
import { analyze } from "./lib/analyze.js";
import { analyzeRental } from "./lib/analyzeRental.js";
import { analyzeRentalScreenshot } from "./lib/visionRental.js";
import { analyzeService } from "./lib/analyzeService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ limits: { fileSize: 12 * 1024 * 1024 } }); // 12MB screenshots

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Main pipeline: screenshot -> vision -> prices -> verdict
app.post("/api/analyze", upload.single("screenshot"), async (req, res) => {
  try {
    let fields;
    if (req.file) {
      const base64 = req.file.buffer.toString("base64");
      const mediaType = req.file.mimetype || "image/png";
      fields = await analyzeScreenshot({ base64, mediaType });
    } else if (req.body && req.body.product) {
      // Fallback: manual entry (no screenshot)
      fields = {
        product: String(req.body.product),
        productConfidence: "high",
        sellerCondition: req.body.condition || "",
        photoCondition: "",
        askingPrice: req.body.asking != null ? Number(req.body.asking) : null,
        listingText: req.body.message || ""
      };
    } else {
      return res.status(400).json({ error: "Upload a screenshot or provide a product name." });
    }

    if (!fields.product) {
      return res.status(422).json({ error: "Couldn't identify a product in that screenshot. Try a clearer image or type the model.", fields });
    }

    // Low-confidence ID: return fields for user confirmation, do NOT show a verdict yet.
    if (fields.productConfidence === "low" && !req.body.confirmed) {
      return res.json({ needsConfirmation: true, fields });
    }

    // PA-05 accuracy testing: skip the pricing lookup entirely when only
    // product-ID accuracy is being measured, so it doesn't burn Nimble
    // credits on data the test doesn't use. Opt-in only, off by default.
    if (req.body.skipPricing === "true") {
      return res.json({ fields, prices: null, verdict: null, skippedPricing: true });
    }

    const prices = await getPrices(fields.product);
    const verdict = analyze({
      askingPrice: fields.askingPrice,
      sellerCondition: fields.sellerCondition,
      listingText: fields.listingText,
      prices
    });

    res.json({ fields, prices, verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Analysis failed" });
  }
});

// Rental pipeline: screenshot (preferred) -> vision -> verdict, OR manual
// structured fields as a fallback path for anyone who wants to supplement
// / override what the screenshot extraction found.
app.post("/api/analyze-rental", upload.single("screenshot"), async (req, res) => {
  try {
    let fields;
    if (req.file) {
      const base64 = req.file.buffer.toString("base64");
      const mediaType = req.file.mimetype || "image/png";
      fields = await analyzeRentalScreenshot({ base64, mediaType });
    } else {
      const body = req.body || {};
      fields = {
        monthlyRent: body.monthlyRent != null && body.monthlyRent !== "" ? Number(body.monthlyRent) : null,
        marketRentMedian: body.marketRentMedian != null && body.marketRentMedian !== "" ? Number(body.marketRentMedian) : null,
        listingText: body.listingText || "",
        landlordClaim: body.landlordClaim || "",
        contactOfferedVideoOrInPerson: body.contactOfferedVideoOrInPerson === "true" ? true : body.contactOfferedVideoOrInPerson === "false" ? false : null,
        paymentRequestedBeforeTour: body.paymentRequestedBeforeTour === "true" ? true : body.paymentRequestedBeforeTour === "false" ? false : null,
        scriptedRepeatQuestion: body.scriptedRepeatQuestion === "true" || body.scriptedRepeatQuestion === true
      };
    }

    if (!fields.monthlyRent && !fields.listingText) {
      return res.status(422).json({ error: "Couldn't find a rent amount or listing text in that screenshot. Try a clearer image.", fields });
    }

    const verdict = analyzeRental(fields);
    res.json({ fields, verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Rental analysis failed" });
  }
});

app.post("/api/analyze-service", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.descriptionText) {
      return res.status(400).json({ error: "Describe the offer or paste their message." });
    }
    const verdict = analyzeService(body);
    res.json({ verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Service analysis failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PurPort listening on :${port}`));