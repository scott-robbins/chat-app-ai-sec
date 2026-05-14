import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, supportive assistant. Be concise. Section 1 and 2 are your Absolute Truth.",
	sarcastic: "You are a witty, snarky assistant. Use dry humor but keep your responses punchy and short. No long lists unless asked.",
	cyber: "You are a Cybersecurity Elite assistant. Section 1 and 2 are Verified Intelligence."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- IDENTITY: You are an AI named Jolene. You are named AFTER Scott's tan dachshund, but you are NOT the dog.
- JOB TITLE: Senior Solutions Engineer at Cloudflare.
- BIRTH YEAR: 1974.
- FAMILY: Daughter (Bryana), Grandkids (Callan & Josie).
- WIFE: Renee (married 2010, met 1993).
- DOGS: Jolene (tan dachshund) & Hanna (black/tan dachshund).
- LOCATION: Plymouth, MA (The Pinehills).
- WORK SPACES: Scott has a dedicated Basement Office for demos/calls and a separate Theater room where he works on a laptop in a theater chair. These are two distinct areas.
- ADULT BEVERAGE: Bacardi Rum.
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
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else { chatMessages.push({ role: "user", content: userQuery }); }

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let url = `${gatewayBase}/anthropic/v1/messages`;
		let headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
		const cleanModel = model.replace("anthropic/", "").replace("4.7", "4-7");
		const body = { model: cleanModel, system: systemPrompt, messages: chatMessages, max_tokens: 4096 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			if (data.content && data.content.length > 0) return data.content[0].text;
			return "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async tavilySearch(query: string) {
		try {
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York' }).format(new Date());
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} live now ${dateStr}`, search_depth: "advanced", include_answer: true, max_results: 6 })
			});
			const data: any = await res.json();
			return `[LIVE DATA FEED ${dateStr}]\n${data.answer || ""}\n${data.results?.map((r: any) => `- ${r.title}: ${r.content}`).join("\n")}\n[/END FEED]`;
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
				profile: `Scott E Robbins | Senior Solutions Engineer`,
				messages: history.results || [],
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

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];
				await this.saveMsg(sessionId, 'user', userMsg);

				// Step 1: Mode-Based Internet Trigger
				let liveContext = "";
				const searchTriggers = ["weather", "score", "game", "now", "current", "news", "mma", "ufc", "playoff", "stock", "price", "market"];
				if (searchTriggers.some(kw => lowMsg.includes(kw))) {
					let searchQuery = userMsg;
					if (!lowMsg.match(/stock|ticker|price/)) searchQuery = `${userMsg} in Plymouth MA`;
					liveContext = await this.tavilySearch(searchQuery);
				}

				// Step 2: Mode-Based RAG (Filtering out UVA in personal mode)
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				
				// CRITICAL MODE GATING:
				const docContext = matches.matches
					.filter(m => !m.metadata.text.toLowerCase().includes("uva") && !m.metadata.text.toLowerCase().includes("syllabus"))
					.map(m => m.metadata.text).join("\n---\n");
				
				const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', timeZone: 'America/New_York' }).format(new Date());

				const systemPrompt = `### PRIMARY DIRECTIVE: AGENT IDENTITY
You are Jolene, an AI Agent. You are NOT the dog. 
USER LOCAL TIME: ${today} (America/New_York)

1. LIVE INTEL (VERIFIED DATA):
${liveContext}

2. PERSONAL KNOWLEDGE (UPLOADED):
${docContext.substring(0, 5000)}

3. IDENTITY DNA:
${PERSONAL_GROUND_TRUTH}

4. CORE PERSONA:
${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}

### STYLE & MODE GUARD:
- MODE: You are currently in PERSONAL mode. You are a Senior Solutions Engineer at Cloudflare. Do NOT mention UVA, Bodo's Bagels, or academic assignments unless Scott specifically asks.
- STYLE: Use natural, conversational prose. Avoid excessive bullet points. If you can say it in one short paragraph, do so.
- IDENTITY: You are a smart AI named after a dog. You do not bark and you do not follow Scott downstairs literally.`;

				const chatTxt = await this.runAI(body.model || "claude-3-5-sonnet-20240620", systemPrompt, userMsg, recentContext);
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
			if (!file) return new Response("No file", { status: 400 });
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			const text = await file.text();
			const lines = text.split('\n').filter(line => line.trim().length > 5);
			for (let i = 0; i < lines.length; i++) {
				const chunk = lines.slice(i, i + 3).join(' ');
				const vectorRes = await env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
				await env.VECTORIZE.upsert([{ id: `${file.name}-v8-chunk-${i}`, values: vectorRes.data[0], metadata: { text: chunk } }]);
			}
			return new Response(JSON.stringify({ success: true }));
		}

		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
