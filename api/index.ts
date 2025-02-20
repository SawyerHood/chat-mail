import { Hono } from "hono";
import { handle } from "hono/vercel";
import Mailgun from "mailgun.js";
import FormData from "form-data";
import OpenAI from "openai";

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

export const config = {
  runtime: "edge",
};

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

const app = new Hono().basePath("/api");

// Basic health check endpoint
app.get("/", (c) => {
  return c.json({ status: "healthy" });
});

interface MailgunWebhookBody {
  sender: string;
  subject: string;
  "stripped-text": string;
  [key: string]: unknown;
}

// Mailgun webhook endpoint
app.post("/incoming-email", async (c) => {
  try {
    const body = (await c.req.parseBody()) as MailgunWebhookBody;

    // Extract email content from the webhook payload
    const sender = body.sender;
    const subject = body.subject;
    const strippedText = body["stripped-text"]; // Plain text without quotes

    if (!strippedText) {
      throw new Error("No email content found");
    }

    // Generate response using ChatGPT
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful email assistant. Provide clear and concise responses.",
        },
        {
          role: "user",
          content: strippedText,
        },
      ],
      model: "gpt-4o-mini",
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
      text: `${aiResponse}\n\n------ Original Message ------\nFrom: ${sender}\nSubject: ${subject}\n\n${strippedText}`,
    });

    return c.json({ status: "success", message: "Response sent successfully" });
  } catch (error: unknown) {
    console.error("Error processing email:", error);
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return c.json({ status: "error", message: errorMessage }, 500);
  }
});

export default handle(app);
