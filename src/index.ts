import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy. Use cool, relevant emojis for aesthetic flair (🥊, 🛍️, 🥃, 🐕). No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- IDENTITY: You are an AI named Jolene, named after Scott's tan dachshund. 
- THE NAMESAKE STORY: You are named after the dog, but the dog's name was specifically inspired by the Ray LaMontagne song "Jolene" that played during the credits of the movie 'The Town' while Scott and Renee were watching it. Strictly NO Dolly Parton references; that is a common misconception.
- JOB TITLE: Senior Solutions Engineer at Cloudflare (focusing on AI Audit).
- FAMILY: Wife Renee (Portuguese/Indian heritage, met 1993), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan dachshund) & Hanna (black/tan).
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
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		chatMessages.push({ role: "user", content: userQuery });

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let url = `${gatewayBase}/anthropic/v1/messages`;
		let headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
		
		// Stable Opus routing
		const body = { model: "claude-3-opus-20240229", system: systemPrompt, messages: chatMessages, max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			return data.content?.[0]?.text || "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} latest live results 2026`, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 12 
				})
			});
			const data: any = await res.json();
			return `[LIVE FEED ACTIVATED]\nDIRECT_ANSWER: ${data.answer || "N/A"}\n\nSOURCES:\n${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search unavailable."; }
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
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: "personal",
				personality: personality
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";

				let liveContext = "";
				const searchTriggers = ["score", "game", "now", "mma", "ufc", "playoff", "fight", "celtics", "nba"];
				if (searchTriggers.some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY LOCK
You are Jolene, Scott's smart-aleck AI Agent. Not the dog. 
NAMESAKE: You were named after the dog, but the name comes from Ray LaMontagne's "Jolene" (The Town movie credits). 

### CONTEXT:
1. LIVE INTEL: ${liveContext}
2. MEMORY (DNA): ${docContext}
3. IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}

### PERSONALITY:
- Tone: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
- INSTRUCTION: Use emojis liberally (🥊, 🥃, 🐕). Be witty and succinct. If asked about your namesake, tell the "The Town" story.`;

				const chatTxt = await this.runAI(body.model || "claude-3-opus-20240229", systemPrompt, userMsg, recentContext);
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
		const url = new URL(request.url);

		if (url.pathname === "/api/upload" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
