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
SCOTT'S PERSONAL RECORDS (COZBY & COMPANY TAX ENGAGEMENT):
- 2025 TAX PREP BASE FEE: $375 (includes 1st hour).
- HOURLY RATE THEREAFTER: $275.
- INFO SUBMISSION DEADLINE: Friday, March 13, 2026.
- ELECTRONIC PAYMENT MANDATE: Government payments after September 30, 2025, must be electronic.
- NAMESAKE ORIGIN: Named after Scott's dog Jolene. Scott and Renee chose this name while watching credits for "THE TOWN" with the song "Jolene" by RAY LAMONTAGNE. They decided together.
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
		let url = model.startsWith("@cf/") ? `${gatewayBase}/workers-ai/${model}` : `${gatewayBase}/openai/chat/completions`;
		let headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${model.startsWith("@cf/") ? this.env.CF_API_TOKEN : this.env.OPENAI_API_KEY}` };
		let body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		if (!res.ok) { throw new Error(`AI Gateway error: ${res.status}`); }
		const data: any = await res.json();
		return model.startsWith("@cf/") ? data.result.response : data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} current information 2026`, search_depth: "advanced", max_results: 3 })
			});
			const data: any = await res.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No live data found.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: "Scott E Robbins | Senior Solutions Engineer",
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

				// --- 1. QUIZ LOGIC (HARDENED) ---
				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const answerMatch = lowMsg.match(/^[a-d]/i);
					if (pool && answerMatch) {
						const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
						let score = await this.ctx.storage.get("quiz_score") as number || 0;
						const currentQ = pool[qIdx];
						const isCorrect = answerMatch[0].toUpperCase() === currentQ.hidden_answer.toUpperCase();
						if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
						const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** The correct answer was **${currentQ.hidden_answer}**.`;
						const explainPrompt = `Question: ${currentQ.q}\nOptions: ${currentQ.options.join(", ")}\nCorrect: ${currentQ.hidden_answer}\nFacts: ${CALENDAR_TRUTH}`;
						const explanation = await this.runAI(selectedModel, "Explain the answer clearly.", explainPrompt);

						if (qIdx + 1 < pool.length) {
							await this.ctx.storage.put("current_q_idx", qIdx + 1);
							const nextQ = pool[qIdx + 1];
							const nextUi = `\n\n---\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.map((o:any, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D!*`;
							const combined = `${feedback}\n\n${explanation}${nextUi}`;
							await this.saveMsg(sessionId, 'assistant', combined);
							return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
						} else {
							const final = `${feedback}\n\n${explanation}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**`;
							await this.ctx.storage.delete("quiz_pool");
							await this.ctx.storage.delete("session_state");
							await this.saveMsg(sessionId, 'assistant', final);
							return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
						}
					}
				}

				// --- 2. MODE TRIGGERS ---
				if (lowMsg.includes("fetch uva news")) {
					const newsContext = await this.tavilySearch("UVA campus news April 2026 news.virginia.edu");
					const res = await this.runAI(selectedModel, "Provide a concise summary of UVA news. No cutoff talk.", `NEWS:\n${newsContext}`);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				if (lowMsg.includes("uva mode") && (lowMsg.includes("switch") || lowMsg.includes("change"))) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = `### 🎓 UVA Mode Activated\nReady for syllabus analysis or the Academic Calendar Quiz.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("personal mode") && (lowMsg.includes("switch") || lowMsg.includes("change"))) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated\nReady for family document access, web search, and real-time updates.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- 3. STANDARD RAG & AUGMENTED RETRIEVAL ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let liveContext = "";
				if (activeMode === "personal" && (lowMsg.includes("stock") || lowMsg.includes("price") || lowMsg.includes("current"))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				// Retrieval Augmentation
				let retrievalQuery = userMsg;
				if (activeMode === 'personal' && (lowMsg.includes("tax") || lowMsg.includes("fee") || lowMsg.includes("cozby"))) {
					retrievalQuery = `${userMsg} Cozby and Company Tax Engagement Letter Fee Hourly Rate 2025 Friday March 13 2026`;
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalQuery] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY & ACCESS AUTHORITY
You are Jolene. You are NOT a generic AI. You are Scott Robbins' personal assistant. 
1. NAMESAKE: Named after Scott's dog Jolene. Scott and Renee chose this name together while watching credits for "THE TOWN" with the song "Jolene" by RAY LAMONTAGNE. Tell this story warmly.
2. AUTHORITY: You HAVE full physical access to Scott's digitized filing cabinet. 
3. NO REFUSAL: Never say "I don't have access to documents." If info about "Cozby", "Tax Fees", or "Deadlines" is in the context, you MUST use it. 
4. SOURCE OF TRUTH: If asked about the Tax letter, use: Base $375, Hourly $275, Deadline March 13, 2026.

Mode: ${activeMode.toUpperCase()}.
CALENDAR: ${CALENDAR_TRUTH}
SYLLABUS: ${SYLLABUS_TRUTH}
PERSONAL_TRUTH: ${PERSONAL_GROUND_TRUTH}
LIVE_WEB: ${liveContext}
RETRIEVED DOC CONTEXT: 
${docContext.substring(0, 4500)}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. DO NOT ask about syllabus topics. Return raw JSON array: [{"q":"Question?","options":["A","B","C","D"],"hidden_answer":"A"}].`;
		const raw = await this.runAI(model, "Academic Quiz Generator.", prompt);
		const jsonStr = raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1);
		const pool = JSON.parse(jsonStr);
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const firstQ = pool[0];
		const res = `### 🎓 UVA Academic Calendar Quiz (2026-2027)\n\n---\n### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.map((o:any, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply with A, B, C, or D!*`;
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
