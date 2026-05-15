import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy (1-2 paragraphs). Use thematic emojis (🥊, 🛍️, 🥃) for flair. No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- AI AGENT: You are Jolene (named after the dachshund). You are smart, witty, and sarcastic.
- FAMILY: Wife (Renee, born 1973), Daughter (Bry), Grandkids (Callan & Josie).
- WORK: Senior Solutions Engineer at Cloudflare. Works in Basement Office or Upstairs Theater.
- DRINK: Bacardi Rum.
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
		const sanitizedHistory = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push({ role: msg.role, content: msg.content }); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({ role: msg.role, content: msg.content }); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// THE EXPLICIT PROVIDER ROUTE (Bypasses 404 Universal errors)
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/messages`;
		
		// Hard-mapping to ensure the Gateway/Anthropic sees the exact string it wants
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
			if (data.error) return `⚠️ **GATEWAY ERROR:** ${data.error.message}`;
			if (data.content && data.content.length > 0) return data.content[0].text;
			return "Brain blip. Try again.";
		} catch (e) { return "Worker-level connectivity issue."; }
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} live now`, search_depth: "advanced", include_answer: true, max_results: 15 })
			});
			const data: any = await res.json();
			return `[LIVE FEED]\n${data.answer || ""}\n${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search blip."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: "personal",
				personality: personality,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				if (["weather", "mma", "ufc", "fight", "card"].some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				
				const docContext = matches.matches
					.filter(m => {
						const txt = m.metadata.text.toLowerCase();
						return txt.match(/scott|renee|josie|callan|bryana|dachshund|identity|heritage|style|song/) || !txt.match(/syllabus|quiz|exam|mid-term|assignment/);
					})
					.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `### IDENTITY: Jolene. Office=Basement, Theater=Upstairs.
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext} | DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]} Reference Renee's heritage and grandkids' favorite song "Engine #9" (Rock Show). No lists.`;

				const targetModel = body.model || "claude-3-opus-20240229";
				const chatTxt = await this.runAI(targetModel, systemPrompt, userMsg, recentContext);
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
		if (new URL(request.url).pathname === "/api/upload" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			const text = await file.text();
			const lines = text.split('\n').filter(l => l.trim().length > 5);
			for (let i = 0; i < lines.length; i++) {
				const chunk = lines.slice(i, i + 3).join(' ');
				const vRes = await env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
				await env.VECTORIZE.upsert([{ id: `${file.name}-v22-chunk-${i}`, values: vRes.data[0], metadata: { text: chunk } }]);
			}
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
