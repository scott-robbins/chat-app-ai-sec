import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: TAVILY SEARCH (Real World Eyes) ---
	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY,
					query: query,
					search_depth: "basic",
					max_results: 3
				})
			});
			const data = await response.json() as any;
			return data.results.map((r: any) => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
		} catch (e) {
			return "Search failed.";
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
			).bind(sessionId).all();
			const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
			return new Response(JSON.stringify({ messages: results, theme }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/save-theme" && request.method === "POST") {
			const { theme } = await request.json() as any;
			await this.env.SETTINGS.put(`global_theme`, theme);
			return new Response("OK");
		}

		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			return new Response(JSON.stringify({ 
				profile: profile || "No global profile saved yet.",
				messageCount: stats?.count || 0 
			}), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/files") {
			const objects = await this.env.DOCUMENTS.list();
			const files = objects.objects.map(o => ({ key: o.key }));
			return new Response(JSON.stringify({ files }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			const text = await file.text();
			const chunks = text.split(/\n/).filter(c => c.trim().length > 0);

			for (const chunk of chunks) {
				const embeddingResponse = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
				await this.env.VECTORIZE.insert([{
					id: crypto.randomUUID(),
					values: embeddingResponse.data[0],
					metadata: { text: chunk, fileName: file.name, sessionId }
				}]);
			}
			await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
			return new Response("OK");
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";
				const lowMsg = latestUserMessage.toLowerCase();

				// Functional Theme Trigger
				if (lowMsg.includes("change my ui to") || lowMsg.includes("set theme to")) {
					const newTheme = lowMsg.includes("plain") ? "plain" : "fancy";
					await this.env.SETTINGS.put(`global_theme`, newTheme);
					return new Response(`data: ${JSON.stringify({ response: `Theme set to ${newTheme}`, themeUpdate: newTheme })}\n\ndata: [DONE]\n\n`);
				}

				// Search Intent Detection
				const searchIntent = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Does this require real-time info? "YES" or "NO" only. User: ${latestUserMessage}`
				});
				
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) {
					searchResults = await this.searchWeb(latestUserMessage);
				}

				// Vector Retrieval (RAG)
				let contextText = "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const globalProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				let sysPrompt = `You are Jolene. Profile: ${globalProfile}\nFile Context: ${contextText}\nSearch: ${searchResults}`;
				
				messages.unshift({ role: "system", content: sysPrompt });
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				const finalContent = chatRun.response || "I'm processing...";

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) {
				return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`);
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
