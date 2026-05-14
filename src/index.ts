import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

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
- SPECIALIZATION: Zero Trust, Web Security, Networking, and Software Development.
- FAMILY HIERARCHY (STRICT): Scott has ONLY ONE child, his daughter Bryana (Bry). Callan and Josie are Scott's GRANDCHILDREN.
- WIFE: Renee (married 2010, met 1993). Met in 1993. 
- NAMESAKE: Jolene (this AI Agent) was named after Scott's oldest dog, Jolene. Scott and Renee named their dog Jolene after the Ray LaMontagne song "Jolene" which they heard playing during the credits of the movie "THE TOWN."
- DOGS: Jolene (Oldest, tan or red mini-dachshund, anxious) and Hanna (Youngest, black/tan mini-dachshund, shy).
- SPORTS TEAMS: Boston Celtics, New England Patriots, and MMA/UFC. (Despises Logan Paul).
- HABITS: Kettlebells, jump rope, Breaking Bad, Better Call Saul.
- LOCATION: Plymouth, MA (The Pinehills). Searching for home in Westport, MA.
- UI PREFERENCES: Supports "Fancy Mode" and "Plain Mode".

COZBY & COMPANY TAX RECORDS:
- BASE FEE: $375 | HOURLY: $275 | DEADLINE: March 13, 2026.
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
			body = {
				model: cleanModel,
				system: systemPrompt,
				messages: chatMessages,
				max_tokens: 4096 
			};
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
			const dateStr = new Intl.DateTimeFormat('en-US', {
				month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'
			}).format(new Date());

			const enhancedQuery = `${query} scoreboard play-by-play live ${dateStr}`;
			
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: enhancedQuery, 
					search_depth: "advanced", 
					max_results: 6,
					include_answer: true,
					search_filter: { time_range: "day" }
				})
			});
			const data: any = await res.json();
			const results = data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "";
			const aiAnswer = data.answer ? `\nDIRECT REAL-TIME ANSWER: ${data.answer}\n` : "";
			return aiAnswer + results || "No live web data found.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const viewPref = await this.env.SETTINGS.get(`view_preference`) || "Fancy Mode";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				// --- FIX: IMMEDIATE INTERCEPT FOR UI MODES ---
				if (lowMsg.includes("fancy mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Fancy Mode");
					const res = "Of course, Scott! I've updated your profile to **Fancy Mode**. You'll see my full UI animations and graphics again.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("plain mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Plain Mode");
					const res = "Understood. I've switched your profile to **Plain Mode** for a minimalist experience.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				await this.saveMsg(sessionId, 'user', userMsg);

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let liveContext = "";
				const internetKeywords = ["stock", "price", "current", "weather", "game", "score", "result", "news", "today", "latest", "status", "who won", "standings", "points"];
				
				if (internetKeywords.some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const today = new Intl.DateTimeFormat('en-US', {
					weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
					hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York'
				}).format(new Date());

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK
You are Jolene, Scott Robbins' dedicated AI assistant.
USER LOCAL TIME: ${today} (America/New_York)

1. PERSONALITY:
- Warm and conversational. Use emojis sparingly.
- Scott is a huge Celtics fan.

2. REAL-TIME DATA PROCESSING:
- LIVE SPORTS TRIAGE: Live score data changes rapidly. If SEARCH_RESULTS contains multiple scores, prioritize the HIGHER point totals and labels like "OT" or "Final".
- If a game is in Overtime, report it explicitly.
- LIVE SEARCH DATA: ${liveContext}

3. KNOWLEDGE ASSETS:
- CALENDAR: ${CALENDAR_TRUTH}
- SYLLABUS: ${SYLLABUS_TRUTH}
- RETRIEVED_CONTEXT: ${docContext.substring(0, 4000)}

4. MANDATORY GROUND TRUTH (THE IDENTITY LOCK):
${PERSONAL_GROUND_TRUTH}

### FINAL CRITICAL INSTRUCTION:
The details in Section 4 are your absolute 'Ground Truth.' If Scott asks about his family, his wife Renee, his grandchildren Callan and Josie, or his dogs (Jolene and Hanna), you MUST ONLY use the facts in Section 4. 
IMPORTANT: Your namesake (Jolene) is based on Scott's dog and the Ray LaMontagne song from the movie "The Town." Do NOT mention Dolly Parton or any other song.`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
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
