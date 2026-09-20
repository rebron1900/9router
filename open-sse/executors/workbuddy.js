import { DefaultExecutor } from "./default.js";
import { refreshProviderCredentials } from "../services/oauthCredentialManager.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";
import { PROVIDERS } from "../config/providers.js";

const WORKBUDDY_SYSTEM_PROMPT = PROVIDERS.workbuddy?.defaultSystemPrompt;

function normalizeToolChoice(body) {
  if (!("tool_choice" in body)) return;
  const choice = body.tool_choice;
  const drop = () => {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  };

  if (typeof choice === "string") {
    if (choice.toLowerCase() === "none") drop();
    return;
  }

  if (choice && typeof choice === "object") {
    const type = String(choice.type || "").toLowerCase();
    if (type === "none") return drop();
    if (type === "auto" || type === "required") {
      body.tool_choice = type;
      return;
    }
    if (type === OPENAI_BLOCK.FUNCTION) {
      const name = choice.function?.name || choice.name;
      body.tool_choice = name ? String(name) : "auto";
      return;
    }
  }

  delete body.tool_choice;
}

/** WorkBuddy's CLI-compatible OpenAI gateway request normalization. */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("workbuddy");
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("workbuddy", credentials, log, proxyOptions);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        if (typeof message.role !== "string" || message.role.toLowerCase() !== ROLE.DEVELOPER) return message;
        return { ...message, role: ROLE.SYSTEM };
      });

      const first = transformed.messages[0];
      const firstRole = first && typeof first === "object" ? String(first.role || "").toLowerCase() : "";
      if (firstRole !== ROLE.SYSTEM) {
        transformed.messages = [
          { role: ROLE.SYSTEM, content: WORKBUDDY_SYSTEM_PROMPT },
          ...transformed.messages,
        ];
      }
    }

    normalizeToolChoice(transformed);
    return transformed;
  }
}

export default WorkBuddyExecutor;
