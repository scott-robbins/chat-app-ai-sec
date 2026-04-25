import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE: D1 HISTORY LOADER ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		// --- 2. COMMAND CENTER SYNC ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results || [],
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE (WITH PERSONABLE TUTOR, SCORING & STOP QUIZ) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// Save User Input
				await this.saveMsg(sessionId, 'user', userMsg);

				// --- FEATURE: STOP QUIZ ---
				if (lowMsg === "stop quiz" || lowMsg === "exit quiz" || lowMsg === "cancel quiz") {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					await this.ctx.storage.delete("current_q_idx");
					await this.ctx.storage.delete("quiz_score");
					const stopRes = "### 🛑 Quiz Stopped\nI've cleared the session and stopped the quiz. I'm still in UVA Academic mode, so feel free to ask me any questions about your syllabus or the academic calendar!";
					await this.saveMsg(sessionId, 'assistant', stopRes);
					return new Response(`data: ${JSON.stringify({ response: stopRes })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				// A. STATE: GRADING (PERSONABLE & DIRECT)
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const userLetter = lowMsg[0].toUpperCase();
					const correctLetter = currentQ.hidden_answer.toUpperCase();
					const isCorrect = userLetter === correctLetter;
					
					if (isCorrect) {
						score++;
						await this.ctx.storage.put("quiz_score", score);
					}

					const correctIdx = correctLetter.charCodeAt(0) - 65;
					const correctText = currentQ.options[correctIdx];

					const graderPrompt = `
					YOUR DATA:
					- User answered: ${userLetter}
					- Correct answer: ${correctLetter}
					- Correct result: ${isCorrect ? 'Correct' : 'Incorrect'}
					- Explanation fact: ${correctText}
					
					STRICT GROUNDING RULE: 
					- Use ONLY the Explanation Fact provided. 
					- DO NOT bring in outside history (e.g., WWII, Founding dates not listed).
					
					TASK:
					1. Address the user directly as "you". 
					2. Tell them clearly if they were right or wrong (e.g., "That's exactly right!", "Actually, that's not quite correct.").
					3. Explain the fact strictly using: "${correctText}".
					4. If this is Question 5, do NOT ask if they are ready for the next question.
					5. If this is NOT Question 5, you MUST end with the specific phrase: "Ready for question ${index + 2}?"`;
					
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are Jolene, a supportive UVA Tutor. Always address the user as 'you'. Stick strictly to the provided UVA facts." }, { role: "user", content: graderPrompt }] 
					});
					let gradeTxt = gradeRun.response || gradeRun;

					// Continuity Enforcement: If the AI failed to ask, append it.
					if (index + 1 < pool.length) {
						if (!gradeTxt.includes(`question ${index + 2}`)) {
							gradeTxt += `\n\nReady for question ${index + 2}?`;
						}
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						// FINAL SCORE ANNOUNCEMENT (QUIZ CONCLUSION)
						gradeTxt += `\n\n### 🏁 Quiz Complete!\n**Your overall score for this session is ${score}/5.**\n\nYou're becoming quite the UVA expert! I'm here to act as your full study companion, so you can ask me to start another quiz or analyze your documents whenever you're ready.`;
						
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.ctx.storage.delete("current_q_idx");
						await this.ctx.storage.delete("quiz_score");
					}

					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING "CONTINUE"
				if (sessionState === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("ready") || lowMsg.includes("next") || lowMsg.includes("continue"))) {
					const nextQ = pool[index];
					await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
					
					const optionsLines = nextQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
					const uiRes = `### 📝 UVA Academic Calendar Quiz: Question ${index + 1} of 5\n**${nextQ.q}**\n\n${optionsLines}\n\n*Reply A, B, or C (or say 'stop quiz')!*`;
					
					await this.saveMsg(sessionId, 'assistant', uiRes);
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- COMMANDS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = `### 🎓 UVA Academic Study Companion Activated
Welcome to your specialized UVA environment! I am Jolene, and I am here to act as your **Full Study Companion**. 

I am powered by your uploaded University of Virginia documents and syllabus records. Beyond simple answers, I can act as a personal tutor—helping you master your course material through practice tools and deep document analysis.

**How I can support your studies today:**
- **Custom Quizzes**: I can generate practice tests grounded in your specific documents. Say **'Start the UVA Academic Calendar Quiz'** to begin a 5-question challenge regarding important dates and deadlines.
- **Syllabus & Course Insights**: Ask me to find exam dates, grading policies, or office hours hidden in your uploaded files.
- **Administrative Navigation**: I can retrieve contact details for the UVA Registrar or departmental offices from your documents.

What academic goals can I help you achieve today?`;
					
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz") || lowMsg.includes("start the uva academic calendar quiz")) {
					return this.initQuizPool(sessionId);
				}

				// --- STANDARD RAG CHAT ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax Scott Robbins" : "UVA Academic Calendar August 25 Registrar";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `Identity: Jolene. Mode: ${activeMode}. Ground all dates: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar. Always address the user directly as 'you'.` }, 
						{ role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }
					] 
				});
				const chatTxt = chatRun.response || chatRun;

				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				const err = "System Error: " + e.message;
				await this.saveMsg(sessionId, 'assistant', err);
				return new Response(`data: ${JSON.stringify({ response: err })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string): Promise<Response> {
		try {
			const facts = "FACTS: 1. Fall 2026 courses begin August 25. 2. Thanksgiving recess is Nov 25-29. 3. Registrar phone is (434) 982-5300. 4. UVA was founded in 1819. 5. First classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate exactly 5 MCQs specifically about the **UVA Academic Calendar**. Return raw JSON array ONLY: [{"q":"...","options":["..."],"hidden_answer":"A"}].`;
			
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are a JSON API." }, { role: "user", content: prompt }] });
			let raw = typeof quizGen.response === 'string' ? quizGen.response : JSON.stringify(quizGen.response || quizGen);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); 
			if (!jsonMatch) throw new Error("AI failed to build question pool.");
			
			const pool = JSON.parse(jsonMatch[0]);
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("quiz_score", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const firstQ = pool[0];
			const optionsText = firstQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
			const uiRes = `### 📝 UVA Academic Calendar Quiz: Question 1 of 5\n**${firstQ.q}**\n\n${optionsText}\n\n*Reply A, B, or C (or say 'stop quiz')!*`;
			
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) {
			return new Response(`data: ${JSON.stringify({ response: "Quiz Pool Error: " + e.message })}\n\ndata: [DONE]\n\n`);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
