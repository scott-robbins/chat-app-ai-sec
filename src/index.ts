import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Hardcoded fallbacks to bypass GitHub/Wrangler config sync issues
const FALLBACK_ACCOUNT_ID = "3746ba19913534b7653b8af6a1299286";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const tavilyKey = (this.env.TAVILY_API_KEY || "").trim();
			if (!tavilyKey) return "Search failed: Tavily Key missing.";

			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: tavilyKey,
					query: query,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data = await response.json() as any;
			return data.answer || data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const startTime = Date.now();

		// Metric Logger
		const logMetric = (action: string, value: number = 1) => {
			if (this.env.JOLENE_METRICS) {
				this.env.JOLENE_METRICS.writeDataPoint({
					blobs: [action, sessionId, CONVERSATION_MODEL],
					doubles: [value, Date.now() - startTime],
					indexes: [sessionId]
				});
			}
		};

		// --- MEMORIZE ROUTE (Vision + Images API) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				let textToIndex = "";
				let imageUrl = "";

				if (file.type.startsWith("image/")) {
					const imgFormData = new FormData();
					imgFormData.append("file", file);
					
					const token = (this.env.IMAGES_TOKEN || "").trim();
					const accountId = (this.env.ACCOUNT_ID || FALLBACK_ACCOUNT_ID).trim();

					if (!token) throw new Error("Worker cannot find IMAGES_TOKEN secret.");

					const cfImage = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`, {
						method: "POST",
						headers: { "Authorization": `Bearer ${token}` },
						body: imgFormData
					});

					const imgResult = await cfImage.json() as any;
					if (!cfImage.ok || !imgResult.result) {
						throw new Error(`Auth Error (Code: ${imgResult.errors?.[0]?.code}) - Check Dashboard Secrets.`);
					}

					imageUrl = imgResult.result.variants[0]; 
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const imageBuffer = await aiImageRes.arrayBuffer();

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image for a memory database." },
								{ type: "image", image: [...new Uint8Array(imageBuffer)] }
							]}
						]
					}, { gateway: GATEWAY_ID });
					
					textToIndex = vision.response || "Image analyzed.";
					logMetric("image_processed");
				} else {
					textToIndex = await file.text();
					logMetric("document_processed");
				}

				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [textToIndex] }, { gateway: GATEWAY_ID });
				await this.env.VECTORIZE.insert([{ 
					id: crypto.randomUUID(), 
					values: emb.data[0], 
					metadata: { text: textToIndex, fileName: file.name, sessionId, imageUrl } 
				}]);

				return new Response(JSON.stringify({ description: textToIndex }), { headers: { "Content-Type": "application/json" } });
			} catch (err: any) { 
				return new Response(JSON.stringify({ error: err.message }), { status: 500 }); 
			}
		}

		// --- CHAT ROUTE (Gateway Logged) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestUserMessage = body.messages[body.messages.length - 1].content;
				
				// Identity Sidecar
				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				const profileUpdate = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Identity: "${currentProfile}"\nFact: "${latestUserMessage}"\nUpdate concisely (150 chars) or return exact.`
				}, { gateway: GATEWAY_ID });

				if (profileUpdate.response && profileUpdate.response !== currentProfile) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdate.response);
					logMetric("identity_updated");
				}

				// Search logic
				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Need search? YES/NO: ${latestUserMessage}` }, { gateway: GATEWAY_ID });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { searchResults = await this.searchWeb(latestUserMessage); }

				// RAG context
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Identity: ${profileUpdate.response}\nContext: ${contextText}\nSearch: ${searchResults}` },
						...body.messages
					]
				}, { gateway: GATEWAY_ID });

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				logMetric("chat_processed", chatRun.response.length);
				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- PROFILE & HISTORY ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			return new Response(JSON.stringify({ profile: profile || "No profile.", messageCount: stats?.count || 0 }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
		}

		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
