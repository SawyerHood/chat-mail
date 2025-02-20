import express from "express";
import type { Request, Response } from "express";
import MailgunImport, { WebhookResponse } from "mailgun.js";
import FormData from "form-data";
import OpenAI from "openai";

const Mailgun = MailgunImport.default;

// Declare process.env types
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      MAILGUN_API_KEY: string;
      MAILGUN_DOMAIN: string;
      OPENAI_API_KEY: string;
      FROM_EMAIL: string;
    }
  }
}

// Initialize clients
const mailgun = new Mailgun(FormData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY,
  url: "https://api.mailgun.net",
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic health check endpoint
app.get("/api", (req: Request, res: Response) => {
  res.json({ status: "healthy" });
});

interface MailgunWebhookBody {
  sender: string;
  subject: string;
  "stripped-text": string;
  "Message-Id": string;
  attachments: Array<{
    url: string;
    "content-type": string;
    name: string;
    size: number;
  }>;
  [key: string]: unknown;
}

async function downloadAttachment(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download attachment: ${response.status} ${response.statusText}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

// Mailgun webhook endpoint
app.post("/api/incoming-email", async (req: Request, res: Response) => {
  try {
    const body = req.body as MailgunWebhookBody;

    // Extract email content from the webhook payload
    const sender = body.sender;
    const subject = body.subject;
    const strippedText = body["stripped-text"]; // Plain text without quotes
    const messageId = body["Message-Id"];
    const attachments =
      body.attachments && typeof body.attachments === "string"
        ? JSON.parse(body.attachments)
        : [];

    if (!strippedText && attachments.length === 0) {
      throw new Error("No email content or attachments found");
    }

    let messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [
      {
        role: "system",
        content:
          "You are a helpful email assistant. Provide clear and concise responses. If images are included, describe them and incorporate their context into your response.",
      },
    ];

    // Create content array for user message
    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } };

    let userContent: ContentPart[] = [];

    // Add text content if present
    if (strippedText) {
      userContent.push({ type: "text", text: strippedText });
    }

    console.log(attachments);

    // Process attachments
    for (const attachment of attachments) {
      console.log(attachment);
      if (attachment["content-type"].startsWith("image/")) {
        const imageBuffer = await downloadAttachment(attachment.url);
        const base64Image = imageBuffer.toString("base64");

        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${attachment["content-type"]};base64,${base64Image}`,
          },
        });
      }
    }

    // Add combined user message with type assertion
    messages.push({
      role: "user",
      content: userContent, // temporary type assertion to bypass strict typing
    });

    // Generate response using ChatGPT
    const completion = await openai.chat.completions.create({
      messages,
      model: "gpt-4o-mini",
      max_tokens: 1000,
    });

    const aiResponse = completion.choices[0]?.message?.content;
    if (!aiResponse) {
      throw new Error("Failed to generate AI response");
    }

    // Send response email
    await mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from: process.env.FROM_EMAIL,
      to: sender,
      subject: `Re: ${subject}`,
      text: `${aiResponse}`,
      "h:In-Reply-To": messageId,
      "h:References": messageId,
    });

    res.json({ status: "success", message: "Response sent successfully" });
  } catch (error: unknown) {
    console.error("Error processing email:", error);
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({ status: "error", message: errorMessage });
  }
});

// Export the Express app as the default export
export default app;
