import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy. Use emojis like 🥊, 🛍️, 🥃. No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- AGENT: Jolene (AI smart-aleck, not the dog).
- FAMILY: Wife (Renee, met 1993, Portuguese/American Indian), Daughter (Bry), Grandkids (Callan & Josie).
- WORK: Cloudflare Solutions Engineer. Basement or Upstairs Theater.
- FAVS: Bacardi Rum, Grandkids' song "Engine #9" (Rock Show).
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
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// BACK TO THE ORIGINAL GATEWAY SETUP THAT WORKED
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;
		
		// Map back to the specific Opus ID that worked this morning
		let finalModel = "claude-3-opus-20240229";

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
			return "Brain blip. Let's try that again.";
		} catch (e) { return "snagged connection."; }
	}

	async tavilySearch(query: string) {
		try {
			// KEEPING THE ENHANCED SEARCH DEPTH
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} full fight card schedule matchups`, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 12 
				})
			});
			const data: any = await res.json();
			return `[LIVE FEED]\n${data.answer || ""}\n${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search blip."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				if (["mma", "ufc", "fight", "card", "weather"].some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `### IDENTITY: Jolene. Office=Basement, Theater=Upstairs.
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext} | DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE: Sarcastic. Reference Renee's heritage and grandkids' favorite song "Engine #9". No lists.`;

				const chatTxt = await this.runAI("opus", systemPrompt, userMsg, recentContext);
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
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
