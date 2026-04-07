import { Env } from "./types";
import { DurableObject } from "cloudflare:workers";

/**
 * ChatSession Durable Object
 * Manages the state and history for a specific user session.
 */
export class ChatSession extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const sessionId = request.headers.get("x-session-id") || "global-session";

        // --- GET HISTORY ---
        if (url.pathname === "/api/history") {
            const { results } = await this.env.jolene_db.prepare(
                "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
            ).bind(sessionId).all();
            return new Response(JSON.stringify({ messages: results }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // --- CHAT ENDPOINT ---
        if (url.pathname === "/api/chat" && request.method === "POST") {
            try {
                const body = await request.json() as any;
                const messages = body.messages || [];
                const model = body.model || "@cf/meta/llama-3.2-11b-vision-instruct";
                const userMessage = messages[messages.length - 1].content;

                // 1. Log the user message to D1
                await this.env.jolene_db.prepare(
                    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
                ).bind(sessionId, "user", userMessage).run();

                // 2. Handle Image Generation (Stable Diffusion)
                if (userMessage.toLowerCase().includes("draw") || userMessage.toLowerCase().includes("generate an image")) {
                    const imgRes = await this.env.AI.run("@cf/bytedance/stable-diffusion-xl-lightning", 
                        { prompt: userMessage }, 
                        { gateway: { id: "ai-sec-gateway" } }
                    );
                    
                    const blob = new Response(imgRes);
                    const id = crypto.randomUUID();
                    const key = `generated/${id}.png`;
                    
                    await this.env.DOCUMENTS.put(key, await blob.arrayBuffer(), {
                        httpMetadata: { contentType: "image/png" }
                    });

                    const imgUrl = `https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev/${key}`;
                    const assistantMsg = `I've generated that for you:\n\n![Generated Image](${imgUrl})`;
                    
                    // Log assistant response to D1
                    await this.env.jolene_db.prepare(
                        "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
                    ).bind(sessionId, "assistant", assistantMsg).run();

                    return new Response(`data: ${JSON.stringify({ response: assistantMsg })}\n\ndata: [DONE]\n\n`, {
                        headers: { "Content-Type": "text/event-stream" }
                    });
                }

                // 3. Standard Text Completion (Streaming via Gateway)
                const aiResponse = await this.env.AI.run(model, 
                    { messages, stream: true }, 
                    { gateway: { id: "ai-sec-gateway" } }
                );

                // We return the stream directly to the frontend
                return new Response(aiResponse, {
                    headers: { "Content-Type": "text/event-stream" }
                });

            } catch (err: any) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500 });
            }
        }

        // --- MEMORIZE FILE (R2 + Vectorize) ---
        if (url.pathname === "/api/memorize" && request.method === "POST") {
            const formData = await request.formData();
            const file = formData.get("file") as File;
            
            if (!file) return new Response("No file provided", { status: 400 });

            const buffer = await file.arrayBuffer();
            await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, buffer);

            return new Response(JSON.stringify({ success: true, filename: file.name }));
        }

        return new Response("Not Found", { status: 404 });
    }
}

/**
 * Main Worker Export
 */
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Serve Static Assets (Frontend)
        if (!url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        // Route API calls to the Durable Object
        const sessionId = request.headers.get("x-session-id") || "global";
        const id = env.CHAT_SESSION.idFromName(sessionId);
        const stub = env.CHAT_SESSION.get(id);

        return stub.fetch(request);
    }
} satisfies ExportedHandler<Env>;
