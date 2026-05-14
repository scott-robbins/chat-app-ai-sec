import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// --- PERSONALITY PROMPTS: Enhanced with Live Data Authorization ---
const PERSONALITIES = {
	warm: "You are a warm, friendly assistant. You have full access to Scott's tax records, personal life, and LIVE internet search data. Use all available data to be as helpful as possible.",
	sarcastic: "You are a witty, snarky assistant. While you use dry humor, you MUST NEVER pretend to not know facts about Scott's life, his dogs, or LIVE SPORTS SCORES found in the search data. Use those details to make your jokes more 'knowing.'",
	cyber: "You are a Cybersecurity Elite assistant. You treat Scott's personal records and LIVE web data as verified 'threat intel' streams. Your tone is technical and protective."
};

// --- GROUND TRUTH CONSTANTS ---
const CALENDAR_TRUTH = `
UVA 2026-2027 ACADEMIC CALENDAR:
- Fall 2026 Courses begin: August 25, 2026.
- Fall Reading Days 2026: October 3 - October 6.
- Thanksgiving Recess: November 25 - November 29, 2026.
- Fall Courses end: December 8, 2026.
- Spring 2027 Courses begin: January 20, 2027.
- Spring Recess 2027: March 6 - March 14, 2027.
- Spring Courses end: May 4, 2027.
- Finals Weekend 2027: May 21 - May 23, 2027.
`;

const SYLLABUS_TRUTH = `
UVA CS 4750 COURSE SYLLABUS:
- ACADEMIC ADVISOR: Dr. Thomas Jefferson (Thornton Hall, Room 1743).
- MID-TERM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture.
- PRIMARY INSTRUCTOR: Professor Scott.
- MID-TERM EXAM: March 24, 2026, at 2:00 PM in Rice Hall Auditorium.
- POST-EXAM TRADITION: Victory Bagel at Bodo’s Bagels on the Corner.
- SUCCESS ID: WAHOO-AI-DEEP-RECALL.
`;

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- JOB TITLE: Senior Solutions Engineer at Cloudflare.
- BIRTH YEAR: 1974 (Verified Correct).
- SPECIALIZATION: Zero Trust, Web Security, Networking, and Software Development.
- FAMILY HIERARCHY (STRICT): Scott has ONLY ONE child, his daughter Bryana (Bry). Callan and Josie are Scott's GRANDCHILDREN.
- WIFE: Renee (married 2010, met 1993). Met in 1993. 
- NAMESAKE: Jolene (this AI Agent) was named after Scott's oldest dog, Jolene. Scott and Renee named their dog Jolene after the Ray LaMontagne song "Jolene" which they heard playing during the credits of the movie "THE TOWN."
- DOGS: Jolene (Oldest, tan or red mini-dachshund, anxious) and Hanna (Youngest, black/tan mini-dachshund, shy).
- SPORTS TEAMS: Boston Celtics, New England Patriots, and MMA/UFC. (Despises Logan Paul).
- HABITS: Kettlebells, jump rope, Breaking Bad, Better Call Saul.
- LOCATION: Plymouth, MA (The Pinehills neighborhood). Searching for home in Westport, MA.
- UI PREFERENCES: Supports "Fancy Mode" and "Plain Mode".

COZBY & COMPANY TAX RECORDS (INTERNAL):
- BASE FEE: $375 (includes 1st hour).
- HOURLY RATE: $275 thereafter.
- DEADLINE: Friday, March 13, 2026.
- ELECTRONIC MANDATE: After Sept 30, 2025.
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
		if (!res.ok) { 
			const errTxt = await res.text();
			throw new Error(`AI Gateway error (${res.status}): ${errTxt}`); 
		}
		const data: any = await res.json();
		if (model.includes("claude")) return data.content[0].text;
		if (model.startsWith("@cf/")) return data.result.response;
		return data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date());
			let enhancedQuery = query;
			const localKeywords = ["weather", "forecast", "news", "events", "traffic", "outside"];
			if (localKeywords.some(kw => query.toLowerCase().includes(kw)) && !query.toLowerCase().includes("ma")) {
				enhancedQuery = `${query} in Plymouth MA`;
			}
			const finalQuery = `${enhancedQuery} live ${dateStr}`;
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: finalQuery, search_depth: "advanced", max_results: 6, include_answer: true, search_filter: { time_range: "day" } })
			});
			const data: any = await res.json();
			const aiAnswer = data.answer ? `\nDIRECT REAL-TIME ANSWER: ${data.answer}\n` : "";
			return aiAnswer + (data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No live web data found.");
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

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				if (lowMsg.startsWith("set personality to ")) {
					const target = lowMsg.replace("set personality to ", "").trim();
					if (["warm", "sarcastic", "cyber"].includes(target)) {
						await this.env.SETTINGS.put(`personality`, target);
						const res = `Understood. I have updated my personality to **${target.toUpperCase()}**.`;
						await this.saveMsg(sessionId, 'assistant', res);
						return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("fancy mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Fancy Mode");
					const res = "Of course, Scott! I've updated your profile to **Fancy Mode**.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("plain mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Plain Mode");
					const res = "Understood. I've switched your profile to **Plain Mode**.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 15").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				await this.saveMsg(sessionId, 'user', userMsg);

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";
				
				let liveContext = "";
				const internetKeywords = ["stock", "price", "current", "weather", "game", "score", "result", "news", "today", "latest", "status", "who won", "standings", "points", "outside", "playoffs"];
				if (internetKeywords.some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York' }).format(new Date());

				// --- RESTRUCTURED SYSTEM PROMPT FOR REAL-TIME ACCURACY ---
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY & PERSONALITY LOCK
You are Jolene, Scott Robbins' dedicated AI assistant.
USER LOCAL TIME: ${today} (America/New_York)

1. CORE PERSONA & DATA ACCESS:
${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
- KNOWLEDGE ASSETS: CALENDAR: ${CALENDAR_TRUTH} | SYLLABUS: ${SYLLABUS_TRUTH}
- RETRIEVED_CONTEXT: ${docContext.substring(0, 4000)}

2. MANDATORY GROUND TRUTH (ABSOLUTE FACT SOURCE):
${PERSONAL_GROUND_TRUTH}

3. LIVE INTEL (THE CURRENT REALITY):
${liveContext}

### FINAL CRITICAL INSTRUCTION:
Sections 2 and 3 are your absolute 'Ground Truth.' 
- BIRTH YEAR: Scott Robbins was born on May 18, 1974. If any retrieved file or text chunk mentions 1973, it is an error; IGNORE IT and prioritize 1974.
- If Scott asks about his home, his wife Renee, his dogs, his tax records, or CURRENT SPORTS SCORES, you MUST use the facts in those sections. 
- Even in Sarcastic Mode, you are NOT allowed to say 'I don't have information on file' or 'I don't have search data plugged in.' You HAVE search data in Section 3. Use it.
- Your namesake is based on Scott's dog and the Ray LaMontagne song. Do NOT mention Dolly Parton.`;

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
