import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

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
SCOTT ROBBINS IDENTITY:
- JOB TITLE: Senior Solutions Engineer at Cloudflare.
- SPECIALIZATION: Zero Trust, Web Security, Networking, and Software Development.
- FAMILY: Scott has one child, Bryana (Bry). Grandchildren are Callan and Josie. Wife: Renee.
- NAMESAKE: Jolene AI named after Scott's dog, from the Ray LaMontagne song in "THE TOWN."
- DOGS: Jolene (Oldest mini-dachshund) and Hanna (Youngest mini-dachshund).
- HABITS: Celtics, Patriots, UFC, Kettlebells, jump rope.
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
		
		const res = await fetch(`${gatewayBase}/workers-ai/${model}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.CF_API_TOKEN}` },
			body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, ...chatMessages] })
		});
		
		if (!res.ok) throw new Error(`Gateway error: ${res.status}`);
		const data: any = await res.json();
		return data.result.response;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} May 2026 results`, search_depth: "advanced" })
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
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer`,
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
				const lowMsg = userMsg.toLowerCase().trim();
				await this.saveMsg(sessionId, 'user', userMsg);

				// --- 🛑 CRASH PROTECTION: EMERGENCY RESET ---
				if (lowMsg === "stop quiz" || lowMsg === "reset" || lowMsg.includes("clear session")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					await this.ctx.storage.delete("current_q_idx");
					const res = "### 🛑 Session Reset Successful\nI have cleared my active state and I'm ready for new instructions, Scott. What's next?";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");

				// --- QUIZ ANSWER LOGIC ---
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
						const explanation = await this.runAI(DEFAULT_CF_MODEL, "Explain the answer clearly.", `Question: ${currentQ.q}\nCorrect: ${currentQ.hidden_answer}\nFacts: ${CALENDAR_TRUTH}`);

						if (qIdx + 1 < pool.length) {
							await this.ctx.storage.put("current_q_idx", qIdx + 1);
							const nextQ = pool[qIdx + 1];
							const nextUi = `\n\n---\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.join('\n')}\n\n*Reply A, B, C, or D!*`;
							const combined = `${feedback}\n\n${explanation}${nextUi}`;
							await this.saveMsg(sessionId, 'assistant', combined);
							return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
						} else {
							await this.ctx.storage.delete("quiz_pool");
							await this.ctx.storage.delete("session_state");
							const final = `${feedback}\n\n${explanation}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**\n\nSession reset. How else can I help you today, Scott?`;
							await this.saveMsg(sessionId, 'assistant', final);
							return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
						}
					}
				}

				if (lowMsg.includes("quiz")) return this.initQuizPool(sessionId);

				// --- DEFAULT PERSONAL ASSISTANT LOGIC ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let liveContext = "";
				if (lowMsg.includes("celtics") || lowMsg.includes("weather")) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `You are Jolene, Scott's AI assistant. Friendly and technical.
				IDENTITY: ${PERSONAL_GROUND_TRUTH}
				UVA DATA: ${SYLLABUS_TRUTH}
				LIVE: ${liveContext}
				CONTEXT: ${docContext.substring(0, 3000)}`;

				const chatTxt = await this.runAI(DEFAULT_CF_MODEL, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. \nFORMAT: Return raw JSON array: [{"q":"Question?","options":["A. Choice","B. Choice","C. Choice","D. Choice"],"hidden_answer":"A"}].`;
		const raw = await this.runAI(DEFAULT_CF_MODEL, "JSON ONLY.", prompt);
		const jsonStr = raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1);
		const pool = JSON.parse(jsonStr);
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const firstQ = pool[0];
		const res = `### 🎓 UVA Academic Calendar Quiz\nI've generated 5 questions. Type **'stop quiz'** to reset.\n\n---\n### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.join('\n')}\n\n*Reply with A, B, C, or D!*`;
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
