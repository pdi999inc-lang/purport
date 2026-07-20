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
import { analyzeServiceScreenshot } from "./lib/visionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ limits: { fileSize: 12 * 1024 * 1024, files: 5 } }); // up to 5 screenshots, 12MB each

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

function filesToImages(files) {
  return (files || []).map(f => ({
    base64: f.buffer.toString("base64"),
    mediaType: f.mimetype || "image/png"
  }));
}

// Main pipeline: screenshot(s) -> vision -> prices -> verdict
app.post("/api/analyze", upload.array("screenshots", 5), async (req, res) => {
  try {
    let fields;
    const images = filesToImages(req.files);
    if (images.length) {
      fields = await analyzeScreenshot({ images });
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
      return res.status(400).json({ error: "Upload at least one screenshot or provide a product name." });
    }

    if (!fields.product) {
      return res.status(422).json({ error: "Couldn't identify a product in those screenshots. Try clearer images or type the model.", fields });
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

// Rental pipeline: screenshot(s) (preferred) -> vision -> verdict, OR manual
// structured fields as a fallback path for anyone who wants to supplement
// / override what the screenshots extraction found.
app.post("/api/analyze-rental", upload.array("screenshots", 5), async (req, res) => {
  try {
    let fields;
    const images = filesToImages(req.files);
    if (images.length) {
      fields = await analyzeRentalScreenshot({ images });
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
      return res.status(422).json({ error: "Couldn't find a rent amount or listing text in those screenshots. Try clearer images.", fields });
    }

    const verdict = analyzeRental(fields);
    res.json({ fields, verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Rental analysis failed" });
  }
});

// Service/contractor pipeline: screenshot(s) (preferred) -> vision -> verdict,
// OR manual structured fields as a fallback path.
app.post("/api/analyze-service", upload.array("screenshots", 5), async (req, res) => {
  try {
    let fields;
    const images = filesToImages(req.files);
    if (images.length) {
      fields = await analyzeServiceScreenshot({ images });
    } else {
      const body = req.body || {};
      fields = {
        descriptionText: body.descriptionText || "",
        wasUnsolicited: body.wasUnsolicited === "true" || body.wasUnsolicited === true,
        claimedLicensed: body.claimedLicensed === "true" ? true : body.claimedLicensed === "false" ? false : null,
        providedWrittenEstimate: body.providedWrittenEstimate === "true" ? true : body.providedWrittenEstimate === "false" ? false : null,
        paymentRequestedBeforeWorkStarted: body.paymentRequestedBeforeWorkStarted === "true" ? true : body.paymentRequestedBeforeWorkStarted === "false" ? false : null
      };
    }

    if (!fields.descriptionText) {
      return res.status(422).json({ error: "Couldn't find any readable pitch/message text in those screenshots. Try clearer images or paste the text.", fields });
    }

    const verdict = analyzeService(fields);
    res.json({ fields, verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Service analysis failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PurPort listening on :${port}`));