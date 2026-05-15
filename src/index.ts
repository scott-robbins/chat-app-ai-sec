import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, insightful assistant.",
	sarcastic: "You are a witty, high-level snarky assistant. Use sass. If Scott asks about Renee, she's shopping. Keep it punchy and conversational (1-2 paragraphs). Use emojis (🥊, 🏀, 🛍️, 🥃) liberally. No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant. Very technical and direct."
};

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, Scott Robbins' smart-aleck personal agent. Not the dog.
JOB: Senior Solutions Engineer at Cloudflare (AI Audit focus).
FAMILY: Wife Renee (Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
FAVORITES: Bacardi Rum. Grandkids' song "Engine #9" (Rock Show). Met Renee in 1993.
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitized = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitized) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push({role: "user", content: msg.content}); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({role: msg.role, content: msg.content}); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// Direct Anthropic Call - Bypass Gateway to avoid 404s
		const url = "https://api.anthropic.com/v1/messages";
		let finalModel = "claude-3-5-sonnet-20240620"; 
		if (model.toLowerCase().includes("opus")) finalModel = "claude-3-opus-20240229";

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.env.ANTHROPIC_API_KEY || "",
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify({ model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 })
			});
			const data: any = await res.json();
			if (data.content && data.content.length > 0) return data.content[0].text;
			return data.error ? `⚠️ Error: ${data.error.message}` : "Brain blip.";
		} catch (e) { return "Wiring issue."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// RESTORE COMMAND CENTER METRICS
		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "sarcastic";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Senior Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPers = await this.env.SETTINGS.get(`personality`) || "sarcastic";

				// 1. TAVILY SEARCH
				let liveContext = "";
				if (["mma", "ufc", "fight", "card", "weather"].some(kw => userMsg.toLowerCase().includes(kw))) {
					const tRes = await fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${userMsg} full fight card matchups`, search_depth: "advanced", max_results: 12 })
					});
					const tData: any = await tRes.json();
					liveContext = tData.results?.map((r: any) => r.content).join("\n");
				}

				// 2. VECTOR SEARCH
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY:
${PERSONAL_GROUND_TRUTH}
### CONTEXT:
LIVE: ${liveContext} | MEMORY: ${docContext}
### STYLE:
${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]} Reference Renee's Portuguese/Indian heritage and kids' song "Engine #9" (Rock Show).`;

				const chatTxt = await this.runAI(body.model || "opus", systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		if (new URL(request.url).pathname === "/api/upload") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
