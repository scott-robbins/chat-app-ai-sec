import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// HELPER: Persistent D1 Save
	async saveMessage(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("SQL Save Error:", e); }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. RESTORED: HISTORY LOADER (D1) ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
		}

		// --- 2. RESTORED: PROFILE & R2 ASSETS ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const activeQuiz = await this.ctx.storage.get("active_quiz_question");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					mode: activeMode,
					activeQuiz: !!activeQuiz,
					durableObject: { id: sessionId, state: "Active" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. MEMORIZE (R2 & VECTOR) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				await this.env.DOCUMENTS.put(file.name, await file.arrayBuffer(), { customMetadata: { segment: activeMode } });
				const text = await file.text();
				const chunks = text.match(/[\s\S]{1,1500}/g) || [];
				for (const chunk of chunks) {
					const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{ id: crypto.randomUUID(), values: embedding.data[0], metadata: { text: chunk, segment: activeMode, source: file.name } }]);
				}
				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 4. CHAT ENGINE (WITH STATE MACHINE) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// Immediate Save for Persistence
				await this.saveMessage(sessionId, 'user', userMsg);

				const state = await this.ctx.storage.get("session_state");
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;

				// A. STATE: GRADING A, B, OR C
				if (state === "WAITING_FOR_ANSWER" && activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER: ${userMsg}\nTASK: Grade the user. Be the UVA Study Companion. Facts: Courses start Aug 25, Thanksgiving Nov 25-29, Registrar (434) 982-5300. End with: "Would you like another question?"`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "UVA Tutor" }, { role: "user", content: graderPrompt }] });
					const gradeText = gradeRun.response || gradeRun;

					await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					await this.saveMessage(sessionId, 'assistant', gradeText);
					return new Response(`data: ${JSON.stringify({ response: gradeText })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING "YES" TO CONTINUE
				if (state === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("next"))) {
					return this.generateQuizQuestion(sessionId); 
				}

				// C. COMMANDS
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nAsk me for a 'quiz question' to start studying!";
					await this.saveMessage(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					return this.generateQuizQuestion(sessionId);
				}

				// D. STANDARD RAG
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar 2026";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: `You are Jolene. Mode: ${activeMode}. Ground all dates: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});
				const chatText = chatRun.response || chatRun;

				await this.saveMessage(sessionId, 'assistant', chatText);
				return new Response(`data: ${JSON.stringify({ response: chatText })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	// HELPER: Generate Grounded MCQ
	async generateQuizQuestion(sessionId: string): Promise<Response> {
		const facts = "UVA Academic Calendar 2026: Courses begin Aug 25. Thanksgiving recess Nov 25-29. Registrar (434) 982-5300. Spring Recess March 6-14, 2027.";
		const prompt = `FACTS: ${facts}\nGenerate ONE MCQ. Options A, B, C. Return raw JSON: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown.`;
		
		const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
		let clean = (quizGen.response || quizGen).toString().replace("```json", "").replace("```", "").trim();
		const qData = JSON.parse(clean);
		
		await this.ctx.storage.put("active_quiz_question", qData); 
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

		const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
		await this.saveMessage(sessionId, 'assistant', uiRes);
		return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
