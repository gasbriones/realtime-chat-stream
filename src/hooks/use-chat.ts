import { useState, useRef, useCallback, useEffect } from "react";
import { streamChat, type ChatMessage } from "@/lib/stream-chat";
import { toast } from "@/hooks/use-toast";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  
  // Typewriter state
  const fullContentRef = useRef("");
  const displayedRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  const tickTypewriter = useCallback(() => {
    const full = fullContentRef.current;
    const displayed = displayedRef.current;

    if (displayed.length < full.length) {
      // Reveal 1-3 characters per frame for natural feel
      const charsToAdd = Math.min(
        Math.floor(Math.random() * 3) + 1,
        full.length - displayed.length
      );
      const next = full.slice(0, displayed.length + charsToAdd);
      displayedRef.current = next;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: next } : m
          );
        }
        return [...prev, { role: "assistant", content: next }];
      });
    }

    // Keep ticking if there's more to reveal or stream is still going
    if (displayed.length < full.length || isLoadingRef.current) {
      const now = performance.now();
      const delay = 16; // ~60fps
      if (now - lastFrameRef.current >= delay) {
        lastFrameRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tickTypewriter);
    }
  }, []);

  const isLoadingRef = useRef(false);

  const startTypewriter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tickTypewriter);
  }, [tickTypewriter]);

  const stopTypewriter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Flush remaining content
    const full = fullContentRef.current;
    if (full && displayedRef.current !== full) {
      displayedRef.current = full;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: full } : m
          );
        }
        return prev;
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const send = useCallback(async (input: string) => {
    const userMsg: ChatMessage = { role: "user", content: input };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setIsLoading(true);
    isLoadingRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    fullContentRef.current = "";
    displayedRef.current = "";

    startTypewriter();

    await streamChat({
      messages: newMessages,
      onDelta: (chunk) => {
        fullContentRef.current += chunk;
      },
      onDone: () => {
        isLoadingRef.current = false;
        // Let typewriter finish revealing remaining content
        setTimeout(() => {
          stopTypewriter();
          setIsLoading(false);
        }, 500);
      },
      onError: (err) => {
        isLoadingRef.current = false;
        stopTypewriter();
        setIsLoading(false);
        toast({ title: "Error", description: err, variant: "destructive" });
      },
      signal: controller.signal,
    });
  }, [messages, startTypewriter, stopTypewriter]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    isLoadingRef.current = false;
    stopTypewriter();
    setIsLoading(false);
  }, [stopTypewriter]);

  const clear = useCallback(() => {
    setMessages([]);
    fullContentRef.current = "";
    displayedRef.current = "";
  }, []);

  return { messages, isLoading, send, stop, clear };
}
