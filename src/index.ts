import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		// --- API: FETCH HISTORY ---
		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
			).bind(sessionId).all();
			return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
		}

		// --- API: CHAT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// Log user message to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// Define available tools in the flatter Cloudflare AI format
				const tools = [
					{
						name: "generate_image",
						description: "Call this to create an image or visual.",
						parameters: {
							type: "object",
							properties: {
								prompt: { type: "string", description: "Image description." }
							},
							required: ["prompt"]
						}
					}
				];

				// High-authority system prompt
				let sysPrompt = "You are Jolene. Always use the generate_image tool for visual requests.";
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// PASS 1: Using 70B and FORCING the tool call via tool_choice
				const response = await this.env.AI.run(REASONING_MODEL, { 
					messages, 
					tools, 
					tool_choice: "generate_image", 
					stream: false 
				});

				let finalContent = "";

				// Handle the Forced Tool Call
				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
					let toolOutput = "";
					
					if (tc.name === "generate_image") {
						try {
							console.log("TOOL_CALL: Generating image for:", args.prompt);
							const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
							const fileName = `generated/${crypto.randomUUID()}.png`;
							
							// Put image into R2
							await this.env.DOCUMENTS.put(fileName, imgBlob, {
								httpMetadata:
