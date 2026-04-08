import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY,
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

		const logMetric = (action: string, value: number = 1) => {
			if (this.env.JOLENE_METRICS) {
				this.env.JOLENE_METRICS.writeDataPoint({
					blobs: [action, sessionId, CONVERSATION_MODEL],
					doubles: [value, Date.now() - startTime],
					indexes: [sessionId]
				});
			}
		};

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				let textToIndex = "";
				let imageUrl = "";

				if (file.type.startsWith("image/")) {
					const imgFormData = new FormData();
					imgFormData.append("file", file);
					
					// Force the use of dashboard variables
					const accountId = this.env.ACCOUNT_ID || "3746ba19913534b7653b8af6a1299286";
					const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`;
					
					const cfImage = await fetch(uploadUrl, {
						method: "POST",
						headers: { "Authorization": `Bearer ${this.env.IMAGES_TOKEN}` },
						body: imgFormData
					});

					const imgResult = await cfImage.json() as any;

					if (!cfImage.ok || !imgResult.result) {
						console.error("API Response:", JSON.stringify(imgResult));
						const errMsg = imgResult.errors?.[0]?.message || "Check API Token permissions.";
						throw new Error(`Cloudflare Images Error: ${errMsg}`);
					}

					imageUrl = imgResult.result.variants[0]; 

					// Use Cloudflare's built-in resizing variant
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const blob = await aiImageRes.arrayBuffer();

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image in detail for a memory database. Focus on the main subjects." },
								{ type: "image", image: [...new Uint8Array(blob)] }
							]}
						]
					});
					textToIndex = vision.response || "Image analyzed.";
					logMetric("image_processed");
				} else {
					textToIndex = await file.text();
					logMetric("document_processed");
				}

				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [textToIndex] });
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

		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			const lastMsg = await this.env.jolene_db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").bind(sessionId).first();
			const thinkingAbout = lastMsg?.content ? (lastMsg.content as string).substring(0, 35) + "..." : "Ready to assist";

			const recentLogs = await this.env.jolene_db.prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 20").bind(sessionId).all();
			const allText = recentLogs.results.map(r => r.content).join(" ").toLowerCase();
			const words = allText.match(/\b(\w{5,})\b/g) || [];
			const counts = words.reduce((acc: any, word) => { acc[word] = (acc[word] || 0) + 1; return acc; }, {});
			const keywords = Object.entries(counts).sort((a: any, b: any) => (b[1] as number) - (a[1] as number)).slice(0, 5).map(e => e[0]).join(", ");

			return new Response(JSON.stringify({ 
				profile: profile || "No profile saved.",
				messageCount: stats?.count || 0,
				thinkingAbout: thinkingAbout,
				keywords: keywords || "Analyzing..."
			}), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestUserMessage = body.messages[body.messages.length - 1].content;
				
				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				const profileUpdate = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Identity: "${currentProfile}"\nNew Fact: "${latestUserMessage}"\nUpdate Identity concisely (150 chars max) or return exactly if no new facts.`
				});
				if (profileUpdate.response && profileUpdate.response !== currentProfile) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdate.response);
					logMetric("identity_updated");
				}

				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Need search? "YES/NO": ${latestUserMessage}` });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { 
					searchResults = await this.searchWeb(latestUserMessage); 
					logMetric("web_search");
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Identity: ${profileUpdate.response}\nContext: ${contextText}\nSearch: ${searchResults}` },
						...body.messages
					]
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				logMetric("chat_processed", chatRun.response.length);
				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
			return new Response(JSON.stringify({ messages: results, theme }), { headers: { "Content-Type": "application/json" } });
		}
		if (url.pathname === "/api/files") {
			const objects = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({ files: objects.objects.map(o => ({ key: o.key })) }), { headers: { "Content-Type": "application/json" } });
		}

		return new Response("Not Allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
