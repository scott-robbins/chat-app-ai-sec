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
		const sessionId = request.headers.get("x-session-id") || "global";

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

		// --- GLOBAL BRAIN: FETCH KV PROFILE ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare(
				"SELECT COUNT(*) as count FROM messages WHERE session_id = ?"
			).bind(sessionId).first();

			return new Response(JSON.stringify({ 
				profile: profile || "No global profile saved yet.",
				messageCount: stats?.count || 0 
			}), { 
				headers: { "Content-Type": "application/json" } 
			});
		}

		// --- R2: LIST ALL FILES (RECURSIVE - INCLUDES ALL SUBDIRECTORIES) ---
		if (url.pathname === "/api/files") {
			// R2 .list() is flat by default; it returns all keys regardless of "/"
			// This ensures we get things like 'uploads/global/Family.txt'
			const objects = await this.env.DOCUMENTS.list();
			
			// We return the full key and metadata so the UI can parse folders and icons
			const files = objects.objects.map(o => ({
				key: o.key,
				size: o.size,
				uploaded: o.uploaded
			}));
			
			return new Response(JSON.stringify({ files }), { 
				headers: { "Content-Type": "application/json" } 
			});
		}

		// --- API: MEMORIZE FILE ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				if (!file) return new Response("No file uploaded", { status: 400 });

				const text = await file.text();
				const chunks = text.split(/\n/).filter(c => c.trim().length > 0);

				// Semantic Indexing (Vectorize)
				for (const chunk of chunks) {
					const embeddingResponse = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{
						id: crypto.randomUUID(),
						values: embeddingResponse.data[0],
						metadata: { text: chunk, fileName: file.name, sessionId }
					}]);
				}

				// Physical Storage (R2) - Structured in uploads/
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer(), {
					httpMetadata: { contentType: file.type || "text/plain" }
				});

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
				const lowMsg = latestUserMessage.toLowerCase();

				// 1. SAVE TO PROFILE LOGIC
				if (lowMsg.startsWith("save to my profile:")) {
					const newData = latestUserMessage.replace(/save to my profile:/i, "").trim();
					const existingProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
					const updatedProfile = existingProfile ? `${existingProfile} | ${newData}` : newData;
					await this.env.SETTINGS.put(`global_user_profile`, updatedProfile);
					
					const successMsg = `Got it! I now know: ${updatedProfile}`;
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", successMsg).run();

					return new Response(`data: ${JSON.stringify({ response: successMsg })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				// 2. IMAGE GENERATION LOGIC
				const isAffirmative = ["sure", "yes", "go for it", "do it", "ok"].includes(lowMsg.replace(/[.!?]/g, ""));
				const hasImageKeywords = lowMsg.includes("generate") || lowMsg.includes("draw") || lowMsg.includes("image") || lowMsg.includes("picture");

				if (hasImageKeywords || isAffirmative) {
					let imagePrompt = latestUserMessage;

					if (isAffirmative && !hasImageKeywords) {
						const lastAssistantMsg = messages.findLast((m: any) => m.role === 'assistant')?.content || "";
						imagePrompt = `Photorealistic image of the subject mentioned: ${lastAssistantMsg}`;
					}

					if (hasImageKeywords || isAffirmative) {
						const imageResponse = await this.env.AI.run(IMAGE_MODEL, 
							{ prompt: imagePrompt },
							{ gateway: { id: "ai-sec-gateway" } }
						);
						
						const imageBuffer = await new Response(imageResponse).arrayBuffer();
						const imageKey = `generated/${crypto.randomUUID()}.png`;
						
						await this.env.DOCUMENTS.put(imageKey, imageBuffer, {
							httpMetadata: { contentType: "image/png" }
						});

						const imageUrl = `${PUBLIC_R2_URL}/${imageKey}`;
						const assistantResponse = `Here's that image for you:\n\n![Generated Image](${imageUrl})`;

						await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
							.bind(sessionId, "assistant", assistantResponse).run();

						return new Response(`data: ${JSON.stringify({ response: assistantResponse })}\n\ndata: [DONE]\n\n`, {
							headers: { "Content-Type": "text/event-stream" }
						});
					}
				}

				// 3. STANDARD TEXT/RAG LOGIC
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					if (matches.matches && matches.matches.length > 0) {
						contextText = matches.matches.filter(m => m.metadata?.text).map(m => m.metadata.text).join("\n\n");
					}
				} catch (e) { console.error("RAG Error:", e); }

				const globalProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";

				let sysPrompt = "You are Jolene, a helpful, witty, and highly capable AI personal assistant. " + 
								"You can brainstorm, analyze files, and generate photorealistic images. " +
								"If you offer to draw something and the user agrees, generate the image.";
				
				if (globalProfile) sysPrompt += `\n\nUser Profile: ${globalProfile}`;
				if (contextText) sysPrompt += `\n\nFile Context:\n${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, 
					{ messages },
					{ gateway: { id: "ai-sec-gateway" } }
				);
				
				const finalContent = chatRun.response || chatRun.choices?.[0]?.message?.content || "I'm not sure how to respond.";

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
