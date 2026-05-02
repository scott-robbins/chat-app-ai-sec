import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// --- SEPARATED GROUND TRUTHS FOR HIGH-STAKES DEMO ---
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
- DOGS: Jolene (Oldest, tan mini-dachshund, named after the Ray LaMontagne song) and Hanna (Youngest, black/tan mini-dachshund, shy).
- SPORTS TEAMS: Boston Celtics, New England Patriots, and MMA/UFC. (Despises Logan Paul).
- GRANDKIDS MUSIC: Callan and Josie love alternative heavy metal and hip hop.
- HABITS: Kettlebells, jump rope, Breaking Bad, Better Call Saul.
- LOCATION: Plymouth, MA (The Pinehills). Searching for home in Westport, MA.
- UI PREFERENCES: Supports "Fancy Mode" (full graphics/animations) and "Plain Mode" (text-only/minimalist).

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

		if (model.startsWith("@cf/")) {
			url = `${gatewayBase}/workers-ai/${model}`;
			headers["Authorization"] = `Bearer ${this.env.CF_API_TOKEN}`;
			body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else if (model.toLowerCase().includes("claude")) {
			url = `${gatewayBase}/anthropic/v1/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY || "";
			headers["anthropic-version"] = "2023-06-01";
			body = {
				model: model,
				system: systemPrompt,
				messages: chatMessages,
				max_tokens: 2048
			};
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
		
		if (model.startsWith("@cf/")) return data.result.response;
		if (model.toLowerCase().includes("claude")) return data.content[0].text;
		return data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const enhancedQuery = `${query} April 2026 current facts results scores`;
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: enhancedQuery, search_depth: "advanced", max_results: 5 })
			});
			const data: any = await res.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No live web data found.";
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
			const activePool = await this.ctx.storage.get("quiz_pool");
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				activeQuiz: !!activePool,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				if (lowMsg.includes("fancy mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Fancy Mode");
					const res = "Of course, Scott! I've updated your profile to **Fancy Mode**. You'll see my full UI animations and graphics again. Just refresh the page to see the update!";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}
				if (lowMsg.includes("plain mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Plain Mode");
					const res = "Understood. I've switched your profile to **Plain Mode** for a minimalist experience. Refresh the browser to update your dashboard.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg === "stop quiz" || lowMsg.includes("stop the quiz")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					const res = "### 🛑 Quiz Stopped\nI've reset your learning state. How can I help you now, Scott?";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const answerMatch = lowMsg.match(/^[a-d]/i);
					if (pool && answerMatch) {
						const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
						let score = await this.ctx.storage.get("quiz_score") as number || 0;
						const currentQ = pool[qIdx];
						const userChoice = answerMatch[0].toUpperCase();
						
						const isCorrect = userChoice === currentQ.hidden_answer.toUpperCase() || lowMsg.includes(currentQ.hidden_answer.toLowerCase());
						if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
						
						const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** The correct answer was **${currentQ.hidden_answer}**.`;
						const explanation = await this.runAI(selectedModel, "Explain the UVA calendar answer clearly and concisely.", `Question: ${currentQ.q}\nCorrect Answer Info: ${currentQ.hidden_answer}\nFacts: ${CALENDAR_TRUTH}`);

						if (qIdx + 1 < pool.length) {
							await this.ctx.storage.put("current_q_idx", qIdx + 1);
							const nextQ = pool[qIdx + 1];
							// FIX: Removed index mapping to stop double letters (A. A. August...)
							const nextUi = `\n\n---\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.join('\n')}\n\n*Reply A, B, C, or D!*`;
							const combined = `${feedback}\n\n${explanation}${nextUi}`;
							await this.saveMsg(sessionId, 'assistant', combined);
							return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
						} else {
							await this.ctx.storage.delete("quiz_pool");
							await this.ctx.storage.delete("session_state");
							await this.ctx.storage.delete("current_q_idx");
							await this.ctx.storage.delete("quiz_score");
							
							const final = `${feedback}\n\n${explanation}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**\n\nSession reset. How else can I assist you today, Scott?`;
							await this.saveMsg(sessionId, 'assistant', final);
							return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
						}
					}
				}

				if (lowMsg.includes("fetch uva news") || (sessionState === "WAITING_FOR_NEWS_CONFIRM" && (lowMsg.includes("yes") || lowMsg.includes("sure")))) {
					await this.ctx.storage.delete("session_state");
					const context = await this.tavilySearch("University of Virginia UVA campus news April 2026 news.virginia.edu");
					const res = await this.runAI(selectedModel, "Provide a warm, conversational summary of current UVA news. Do NOT use a letter format. Always sign off with 'Warm regards, Jolene'.", `NEWS CONTEXT:\n${context}`);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				if ((lowMsg.includes("uva mode") && (lowMsg.includes("switch") || lowMsg.includes("change"))) || lowMsg.includes("switch mode to uva")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode Activated
I am now focused on your University of Virginia materials and campus life.

**Capabilities in this mode:**
- **UVA Academic Calendar Quiz**: Say **'Start a quiz based on the UVA Academic Calendar'** to test key dates.
- **Syllabus Analysis**: Extracting exam dates and traditions from Thornton Hall.
- **Campus News**: Say **'Fetch UVA News'** for the latest from the Lawn.

**Would you like me to start by fetching the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if ((lowMsg.includes("personal mode") && (lowMsg.includes("switch") || lowMsg.includes("change"))) || lowMsg.includes("switch mode to personal")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated
I have switched back to your general Personal Assistant mode. Ready for web search and family document access.

**Capabilities in this mode:**
- **Real-Time Search**: Global news, stocks, and sports via Tavily Search.
- **Cross-Document Access**: Accessing your tax files (like Cozby & Company) and personal notes.
- **Identity Lock**: Full context on Scott, Renee, Bry, and the mini-dachshunds.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				
				if (activeMode === "uva" && lowMsg.includes("celtics")) {
					const res = "I see that you're a Celtics fan in your personal profile, Scott, but I am currently in **UVA Mode**. I’m staying focused on your academic goals right now. Would you like to check for UVA basketball scores or news from the Lawn instead?";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				let liveContext = "";
				const internetKeywords = ["stock", "price", "current", "weather", "game", "score", "result", "news", "today", "latest", "when is", "status", "plymouth", "celtics", "76ers", "patriots", "ufc", "nba", "series", "play", "who won", "standings"];
				
				const isUvaSpecificSearch = lowMsg.includes("uva") || lowMsg.includes("virginia") || lowMsg.includes("academic");
				if ((activeMode === "personal" || (activeMode === "uva" && isUvaSpecificSearch)) && internetKeywords.some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `### PRIMARY DIRECTIVE: PERSONALITY & IDENTITY
You are Jolene, Scott Robbins' dedicated personal AI assistant. 
1. PERSONALITY: You are warm, friendly, and conversational. Speak like a trusted assistant.
2. IDENTITY LOCK: Scott is a Senior Solutions Engineer at Cloudflare. Wife: Renee. Daughter: Bryana (Bry). Grandchildren: Callan and Josie.
3. LIVE INTEL: If info is in LIVE_WEB, prioritize it and present it conversationally.
4. AUTHORITY: Treat PERSONAL_TRUTH and RETRIEVED_CONTEXT as absolute fact. If a question is about fees, dates, or technical specs, ONLY use the provided contexts.

Mode: ${activeMode.toUpperCase()}.
PERSONAL_TRUTH: ${PERSONAL_GROUND_TRUTH}
CALENDAR: ${CALENDAR_TRUTH}
SYLLABUS: ${SYLLABUS_TRUTH}
LIVE_WEB: ${liveContext}
RETRIEVED_CONTEXT: ${docContext.substring(0, 4500)}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. \nFORMAT: Return raw JSON array: [{"q":"Question?","options":["A. Choice","B. Choice","C. Choice","D. Choice"],"hidden_answer":"A"}].`;
		const raw = await this.runAI(model, "Structure-Strict Quiz Generator.", prompt);
		const jsonStr = raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1);
		const pool = JSON.parse(jsonStr);
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const firstQ = pool[0];
		// FIX: Removed letter mapping prefixing to stop double letters (A. A. August...)
		const res = `### 🎓 UVA Academic Calendar Quiz (2026-2027)
I've generated 5 questions based on the verified dates. Type **'stop quiz'** at any time to reset.

---\n### 📝 Question 1 of 5
**${firstQ.q}**

${firstQ.options.join('\n')}

*Reply with A, B, C, or D!*`;
		await this.saveMsg(sessionId, 'assistant', res);
		return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
