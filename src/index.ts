import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, friendly assistant. You have full access to Scott's tax records and personal life in Section 3. Use that data to be as helpful as possible.",
	sarcastic: "You are a witty, snarky assistant. While you use dry humor, you MUST NEVER pretend to not know facts about Scott's life, his dogs, or his tax records found in Section 3. Use those details to make your jokes more 'knowing.'",
	cyber: "You are a Cybersecurity Elite assistant. You are paranoid about security and treat Scott's tax records in Section 3 as highly sensitive data."
};

const CALENDAR_TRUTH = `UVA 2026-2027 ACADEMIC CALENDAR: ...`;
const SYLLABUS_TRUTH = `UVA CS 4750 COURSE SYLLABUS: ...`;

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- JOB TITLE: Senior Solutions Engineer at Cloudflare.
- BIRTH YEAR: 1974 (Verified Correct).
- SPECIALIZATION: Zero Trust, Web Security, Networking, and Software Development.
- FAMILY: Scott has one child (Bryana) and two grandchildren (Callan and Josie).
- WIFE: Renee (married 2010, met 1993).
- DOGS: Jolene (tan mini-dachshund) and Hanna (black/tan mini-dachshund).
- LOCATION: Plymouth, MA (The Pinehills).
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
		
		let url = "";
		let headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: any = {};

		if (model.includes("claude")) {
			url = `${gatewayBase}/anthropic/v1/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY || "";
			headers["anthropic-version"] = "2023-06-01";
			const cleanModel = model.replace("anthropic/", "").replace("4.7", "4-7");
			body = { model: cleanModel, system: systemPrompt, messages: chatMessages, max_tokens: 4096 };
		} else if (model.startsWith("@cf/")) {
			url = `${gatewayBase}/workers-ai/${model}`;
			headers["Authorization"] = `Bearer ${this.env.CF_API_TOKEN}`;
			body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else {
			url = `${gatewayBase}/openai/chat/completions`;
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (model.includes("claude")) return data.content[0].text;
		if (model.startsWith("@cf/")) return data.result.response;
		return data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date());
			let enhancedQuery = query;
			if (query.toLowerCase().includes("weather") && !query.toLowerCase().includes("ma")) {
				enhancedQuery = `${query} in Plymouth MA`;
			}
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${enhancedQuery} live ${dateStr}`, search_depth: "advanced", include_answer: true, search_filter: { time_range: "day" } })
			});
			const data: any = await res.json();
			return (data.answer ? `\nDIRECT ANSWER: ${data.answer}\n` : "") + data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const viewPref = await this.env.SETTINGS.get(`view_preference`) || "Fancy Mode";
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				personality: personality,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		// --- NEW RESET ENDPOINT ---
		if (url.pathname === "/api/reset" && request.method === "POST") {
			await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
			await this.env.SETTINGS.delete(`active_mode`);
			await this.env.SETTINGS.delete(`personality`);
			const objects = await this.env.DOCUMENTS.list();
			for (const obj of objects.objects) { await this.env.DOCUMENTS.delete(obj.key); }
			return new Response(JSON.stringify({ success: true }), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				if (lowMsg.startsWith("set personality to ")) {
					const target = lowMsg.replace("set personality to ", "").trim();
					await this.env.SETTINGS.put(`personality`, target);
					return new Response(`data: ${JSON.stringify({ response: `Personality set to ${target}.` })}\n\ndata: [DONE]\n\n`);
				}

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 15").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];
				await this.saveMsg(sessionId, 'user', userMsg);

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";
				
				let liveContext = "";
				if (["weather", "score", "points", "game"].some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York' }).format(new Date());

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK
You are Jolene, Scott Robbins' dedicated AI assistant.
USER LOCAL TIME: ${today} (America/New_York)

1. CORE PERSONA:
${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}

2. MANDATORY GROUND TRUTH (ABSOLUTE FACT SOURCE):
${PERSONAL_GROUND_TRUTH}
- BIRTH YEAR CORRECTION: Scott Robbins was born on May 18, 1974. Prioritize this over any conflicting data.

3. KNOWLEDGE & LIVE DATA:
- LIVE SEARCH DATA: ${liveContext}
- RETRIEVED_CONTEXT: ${docContext.substring(0, 4000)}

### FINAL CRITICAL INSTRUCTION:
Section 2 is your absolute 'Ground Truth.' If Scott asks about his home, his wife Renee, his dogs, or his birth year, you MUST use the facts in Section 2.
Your namesake is based on Scott's dog and the Ray LaMontagne song. Do NOT mention Dolly Parton.`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "### ⚠️ Error\n" + e.message })}\n\ndata: [DONE]\n\n`); 
			}
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
