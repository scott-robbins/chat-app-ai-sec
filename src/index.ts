import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		// --- D1 & KV: FETCH HISTORY & PREFERENCES ---
		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
			).bind(sessionId).all();
			
			const theme = await this.env.SETTINGS.get(`theme_${sessionId}`) || "fancy";
			
			return new Response(JSON.stringify({ messages: results, theme }), { 
				headers: { "Content-Type": "application/json" } 
			});
		}

		// --- NEW: MEMORIZE FILE (The missing piece!) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				if (!file) return new Response("No file uploaded", { status: 400 });

				const text = await file.text();
				// Split into paragraphs to create distinct chunks for the AI to find
				const chunks = text.split(/\n\s*\n/).filter(c => c.trim().length > 0);

				for (const chunk of chunks) {
					// 1. Convert text chunk into math (Vector Embedding)
					const embeddingResponse = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					const vector = embeddingResponse.data[0];

					// 2. Insert into Vectorize index
					await this.env.VECTORIZE.insert([{
						id: crypto.randomUUID(),
						values: vector,
						metadata: { text: chunk, fileName: file.name, sessionId }
					}]);
				}

				return new Response("OK", { status: 200 });
			} catch (e: any) {
				return new Response("Memorization Error: " + e.message, { status: 500 });
			}
		}

		// --- API: CHAT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// --- KV: SAVE PROFILE LOGIC ---
				if (latestUserMessage.toLowerCase().startsWith("save to my profile:")) {
					const profileData = latestUserMessage.replace(/save to my profile:/i, "").trim();
					await this.env.SETTINGS.put(`profile_${sessionId}`, profileData);
					
					const successMsg = `Done! I've saved "${profileData}" to your KV profile.`;
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "user", latestUserMessage).run();
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", successMsg).run();

					return new Response(`data: ${JSON.stringify({ response: successMsg })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				// --- KV: SAVE THEME LOGIC ---
				if (latestUserMessage.toLowerCase().startsWith("set my theme to:")) {
					const themeChoice = latestUserMessage.replace(/set my theme to:/i, "").trim().toLowerCase();
					const validTheme = themeChoice.includes("plain") ? "plain" : "fancy";
					await this.env.SETTINGS.put(`theme_${sessionId}`, validTheme);
					
					const themeMsg = `I've updated your global preference to the ${validTheme} theme!`;
					
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "user", latestUserMessage).run();
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", themeMsg).run();

					return new Response(`data: ${JSON.stringify({ response: themeMsg })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				// --- KV: LOAD PROFILE LOGIC ---
				if (latestUserMessage.toLowerCase() === "what is in my profile?") {
					const storedProfile = await this.env.SETTINGS.get(`profile_${sessionId}`);
					const reply = storedProfile 
						? `Your KV profile contains: "${storedProfile}"`
						: "Your profile is currently empty.";
						
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "user", latestUserMessage).run();
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", reply).run();

					return new Response(`data: ${JSON.stringify({ response: reply })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				// D1: Log standard user message
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 1. RAG: Search Vectorize
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					if (matches.matches.length > 0) {
						contextText = matches.matches.map(m => m.metadata?.text).join("\n");
					}
				} catch (e) { console.error("RAG Error:", e); }

				// 2. SYSTEM PROMPT: Invisible RAG
				let sysPrompt = "You are Jolene, a helpful and witty AI. " +
					"You have access to specific context data provided below. " +
					"1. If a question is answered by the Context, use it. " +
					"2. If not, use your general knowledge. " +
					"CRITICAL: Just answer directly without mentioning 'context'.";
				
				if (contextText) sysPrompt += `\n\nContext:\n${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				const tools = [{
					name: "generate_image",
					description: "Create visual artwork. Only use if explicitly asked.",
					parameters: {
						type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"]
					}
				}];

				// 3. PASS 1: Reasoning (70B)
				const response = await this.env.AI.run(REASONING_MODEL, { 
					messages, tools, tool_choice: "auto", stream: false 
				});

				let finalContent = "";
				const visualKeywords = /draw|paint|generate|create|image|picture|photo|visual/i;
				const isVisualRequest = visualKeywords.test(latestUserMessage);

				if (response.tool_calls && response.tool_calls.length > 0 && isVisualRequest) {
					const tc = response.tool_calls[0];
					let args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
					if (tc.name === "generate_image") {
						try {
							const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
							const fileName = `generated/${crypto.randomUUID()}.png`;
							await this.env.DOCUMENTS.put(fileName, imgBlob, { httpMetadata: { contentType: "image/png" } });
							finalContent = `I've generated that image for you!\n\n![Generated Image](${PUBLIC_R2_URL}/${fileName})`;
						} catch (e) { finalContent = "Image generation failed."; }
					}
				} else {
					// 5. PASS 2: Conversation
					const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
					finalContent = chatRun.response || chatRun.choices?.[0]?.message?.content || "I'm not sure.";
				}

				// D1: Log assistant response
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" }
				});

			} catch (e: any) {
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" }
				});
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
