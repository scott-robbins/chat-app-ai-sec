import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- AGENT: Jolene (AI smart-aleck, NOT the dog).
- FAMILY: Wife (Renee, Portuguese/American Indian heritage), Daughter (Bry), Grandkids (Callan & Josie).
- WORK: Cloudflare SE. Office=Basement, Theater=Upstairs.
- FAVS: Bacardi Rum, Grandkids' song "Engine #9" (Rock Show). met Renee in 1993.
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitized = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitized) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push({role: "user", content: msg.content}); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({role: msg.role, content: msg.content}); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// DIRECT CALL TO ANTHROPIC - NO MIDDLEMAN
		const url = "https://api.anthropic.com/v1/messages";
		const body = {
			model: "claude-3-opus-20240229", // Using your reliable model
			system: systemPrompt,
			messages: chatMessages,
			max_tokens: 1024
		};

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.env.ANTHROPIC_API_KEY || "",
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify(body)
			});
			const data: any = await res.json();
			if (data.content && data.content.length > 0) return data.content[0].text;
			if (data.error) return `⚠️ Jolene's brain says: ${data.error.message}`;
			return "Brain blip. Hit me again.";
		} catch (e) { return "I hit a snag in the wiring."; }
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} full fight card matchups odds`, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 12 
				})
			});
			const data: any = await res.json();
			return `[LIVE INTEL]\nAnswer: ${data.answer || "Searching..."}\nSources: ${data.results?.map((r: any) => r.content).join("\n")}\n[/END]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				
				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 8").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				if (["mma", "ufc", "fight", "card", "weather"].some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `You are Jolene, Scott Robbins' smart-aleck AI Agent. 
CONTEXT:
- LIVE: ${liveContext}
- MEMORY: ${docContext}
- DNA: ${PERSONAL_GROUND_TRUTH}

STYLE: Be witty, sarcastic, and conversational. Reference Renee's Portuguese/American Indian heritage and grandkids' favorite song "Engine #9" (Rock Show). Use 🥊, 🥃, 🛍️ flair. No lists.`;

				const chatTxt = await this.runAI(systemPrompt, userMsg, recentContext);
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
