import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// --- SINGLE SOURCE OF TRUTH FOR THE DEMO ---
const UVA_FACTS = `
UVA 2026-2027 ACADEMIC CALENDAR GROUND TRUTH:
- Fall 2026 Courses begin: August 25, 2026.
- Fall Reading Days 2026: October 3 - October 6.
- Thanksgiving Recess: November 25 - November 29, 2026.
- Fall Courses end: December 8, 2026.
- Spring 2027 Courses begin: January 20, 2027.
- Spring Recess 2027: March 6 - March 14, 2027.
- Spring Courses end: May 4, 2027.
- Finals Weekend 2027: May 21 - May 23, 2027.
- Academic Success Data ID: WAHOO-AI-DEEP-RECALL.

UVA COURSE SYLLABUS DATA (FOR Q&A ONLY - NOT FOR QUIZ):
- ACADEMIC ADVISOR: Dr. Thomas Jefferson (Thornton Hall, Room 1743).
- CS 4750 MID-TERM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture.
- PRIMARY INSTRUCTOR: Professor Scott.
- MID-TERM EXAM: March 24, 2026, at 2:00 PM in Rice Hall Auditorium.
- POST-EXAM TRADITION: Victory Bagel at Bodo’s Bagels on the Corner.
- WAHOO SPIRIT: Congregate at the Lawn Rotunda during system updates.
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
		let headers: Record<string, string> = { 
			"Content-Type": "application/json", 
			"Authorization": `Bearer ${model.startsWith("@cf/") ? this.env.CF_API_TOKEN : this.env.OPENAI_API_KEY}` 
		};
		let body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		return model.startsWith("@cf/") ? data.result.response : data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} current events 2026`, search_depth: "advanced", max_results: 3 })
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

				// --- 1. SPECIAL UVA NEWS HANDLER ---
				if (lowMsg.includes("fetch uva news") || (sessionState === "WAITING_FOR_NEWS_CONFIRM" && (lowMsg.includes("yes") || lowMsg.includes("sure")))) {
					await this.ctx.storage.delete("session_state");
					const newsContext = await this.tavilySearch("University of Virginia UVA campus news April 2026 news.virginia.edu");
					const res = await this.runAI(selectedModel, "You are Jolene. Provide a concise summary of UVA news. No training cutoff talk.", `NEWS CONTEXT:\n${newsContext}`);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- 2. QUIZ LOGIC ---
				if (lowMsg.includes("stop quiz")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					const res = "### 🛑 Quiz Stopped\nI've reset your state. How can I help you now?";
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
						const isCorrect = userChoice === currentQ.hidden_answer.toUpperCase();
						if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }

						const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** The correct answer was **${currentQ.hidden_answer}**.`;
						const explanation = await this.runAI(selectedModel, `Facts: ${UVA_FACTS}`, `Explain why the answer for: ${currentQ.q} is ${currentQ.hidden_answer}. Focus ONLY on calendar dates.`);

						if (qIdx + 1 < pool.length) {
							await this.ctx.storage.put("current_q_idx", qIdx + 1);
							const nextQ = pool[qIdx + 1];
							const nextUi = `\n\n---\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.map((o:any, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D!*`;
							const combined = `${feedback}\n\n${explanation}${nextUi}`;
							await this.saveMsg(sessionId, 'assistant', combined);
							return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
						} else {
							const final = `${feedback}\n\n${explanation}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**\n\nSession reset. How else can I help?`;
							await this.ctx.storage.delete("quiz_pool");
							await this.ctx.storage.delete("session_state");
							await this.saveMsg(sessionId, 'assistant', final);
							return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
						}
					}
				}

				// --- 3. MODE SWITCHES ---
				if (lowMsg.includes("start a quiz based on the uva academic calendar") || (lowMsg.includes("quiz") && lowMsg.includes("uva"))) return this.initQuizPool(sessionId, selectedModel);

				if (lowMsg.includes("uva mode") && (lowMsg.includes("switch") || lowMsg.includes("go to") || lowMsg.includes("change"))) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode Activated\nI am now focused on your University of Virginia materials and campus life.

**Capabilities in this mode:**
- **UVA Academic Calendar Quiz**: Say **'Start a quiz based on the UVA Academic Calendar'** to test key dates.
- **Syllabus Analysis**: Extracting exam dates and traditions from Thornton Hall.
- **Campus News**: Say **'Fetch UVA News'** for the latest from the Lawn.

**Would you like me to start by fetching the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("personal mode") && (lowMsg.includes("switch") || lowMsg.includes("go to") || lowMsg.includes("change"))) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated\nI have switched back to your general Personal Assistant mode. Ready for web search and family document access.

**In this mode I can:**
- **Real-Time Search**: Global news and sports via Tavily Search.
- **Cross-Document Access**: Accessing your tax files and personal notes alongside academic materials.
- **Identity Lock**: Full context on Scott, Renee, Bry, and the mini-dachshunds.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- 4. STANDARD RAG (WITH NO-REFUSAL DIRECTIVE) ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `### PRIMARY DIRECTIVE
You are Jolene. Mode: ${activeMode.toUpperCase()}. 
1. IDENTITY: Scott Robbins (Senior Solutions Engineer at Cloudflare). Wife: Renee. Dogs: Jolene and Hanna. 
2. AUTHORITY: When in UVA mode, you are the official academic assistant for CS 4750. 
3. NO REFUSAL: You MUST provide dates, locations, and instructor details from the GROUND TRUTH below. NEVER say "I don't have access to specific schedules" if the answer is in the facts.

### GROUND TRUTH DATA
${UVA_FACTS}

### RETRIEVED CONTEXT
${docContext.substring(0, 4000)}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `
FACTS TO USE: ${UVA_FACTS}

TASK: Generate 5 Multiple Choice Questions about the UVA 2026-2027 Academic Calendar.
STRICT CATEGORIES TO INCLUDE: Semester start/end dates, Reading Days, Exam windows, Recesses (Thanksgiving/Spring Recess).
STRICT CATEGORIES TO EXCLUDE: Do NOT ask about course topics (Cloudflare architecture), Instructors, Advisors, Room numbers, or syllabus milestones. 

STRICT RULES:
1. One option MUST be the correct date from the FACTS above.
2. Labels MUST be A, B, C, D.
3. hidden_answer MUST be exactly one letter: A, B, C, or D.
Format: Return ONLY raw JSON array: [{"q":"Question?","options":["A","B","C","D"],"hidden_answer":"A"}].`;

		const raw = await this.runAI(model, "You are a specialized UVA Academic Calendar Quiz JSON generator.", prompt);
		const jsonStr = raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1);
		const pool = JSON.parse(jsonStr);
		
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

		const firstQ = pool[0];
		const res = `### 🎓 UVA Academic Calendar Quiz (2026-2027)
I've generated 5 questions based on the verified dates. Type **'stop quiz'** to reset.

---\n### 📝 Question 1 of 5
**${firstQ.q}**

${firstQ.options.map((o:any, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}

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
