"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  User,
  X
} from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { AuthGuard } from "@/components/auth/auth-guard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAssistantContext } from "@/context/assistant-context";
import { apiUrl } from "@/lib/api";

type DocumentMeta = {
  _id: string;
  title: string;
  fileType?: string;
  chunkCount?: number;
  size?: number;
  status?: string;
};

type RagSource = {
  documentId: string;
  title: string;
  chunkIndex: number;
  score?: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: RagSource[];
};

const suggestedPrompts = [
  "Summarize the selected documents",
  "Compare the main differences",
  "Find contradictions or gaps"
];

function parseDocumentIds(idsParam: string | null) {
  return [...new Set(
    (idsParam || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  )];
}

function formatSize(bytes?: number) {
  if (!bytes) return null;

  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatScore(score?: number) {
  if (typeof score !== "number") return null;
  return score.toFixed(2);
}

function MultiDocumentChatContent() {
  const searchParams = useSearchParams();
  const selectedDocumentIds = useMemo(
    () => parseDocumentIds(searchParams.get("ids")),
    [searchParams]
  );
  const selectedDocumentIdKey = selectedDocumentIds.join(",");

  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [missingDocumentIds, setMissingDocumentIds] = useState<string[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const { setContext, clearContext } = useAssistantContext();

  useEffect(() => {
    setContext({
      page: "documents",
      mode: "multi-document-chat",
      documentIds: selectedDocumentIds
    });

    return () => clearContext();
  }, [clearContext, selectedDocumentIdKey, selectedDocumentIds, setContext]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatLoading]);

  useEffect(() => {
    async function loadDocuments() {
      if (!selectedDocumentIds.length) {
        setDocuments([]);
        setMissingDocumentIds([]);
        return;
      }

      try {
        setMetadataLoading(true);
        setMetadataError("");

        const res = await fetch(apiUrl("/documents"), {
          headers: {
            Authorization: "Bearer " + localStorage.getItem("token")
          }
        });

        const data = await res.json();

        if (!data.ok) {
          throw new Error(data.error || "Failed to load documents");
        }

        const allDocuments = (data.documents || []) as DocumentMeta[];
        const byId = new Map(allDocuments.map((document) => [document._id, document]));
        const selectedDocuments = selectedDocumentIds
          .map((id) => byId.get(id))
          .filter(Boolean) as DocumentMeta[];

        setDocuments(selectedDocuments);
        setMissingDocumentIds(
          selectedDocumentIds.filter((id) => !byId.has(id))
        );
      } catch {
        setMetadataError("Could not load selected document details. Make sure the backend server is running.");
      } finally {
        setMetadataLoading(false);
      }
    }

    loadDocuments();
  }, [selectedDocumentIdKey, selectedDocumentIds]);

  async function submitQuestion(questionOverride?: string) {
    const question = (questionOverride || input).trim();
    if (!question || chatLoading || !selectedDocumentIds.length) return;

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: question
      }
    ]);
    setInput("");
    setChatError("");
    setChatLoading(true);

    try {
      const res = await fetch(apiUrl("/documents/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + localStorage.getItem("token")
        },
        body: JSON.stringify({
          documentIds: selectedDocumentIds,
          question
        })
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "The document chat request failed.");
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer || "I could not find relevant information in the selected document(s).",
          sources: Array.isArray(data.sources) ? data.sources : []
        }
      ]);
    } catch (err) {
      setChatError(
        err instanceof Error
          ? err.message
          : "The document chat request failed."
      );
    } finally {
      setChatLoading(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
  }

  if (!selectedDocumentIds.length) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen bg-background">
          <AppSidebar />

          <main
            className="flex-1 transition-[padding] duration-300"
            style={{ paddingLeft: "var(--sidebar-width, 256px)" }}
          >
            <div className="flex min-h-screen items-center justify-center p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>No documents selected</EmptyTitle>
                  <EmptyDescription>
                    Go back to Documents and select files to chat with.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button asChild className="gap-2">
                    <Link href="/documents">
                      <ArrowLeft className="size-4" />
                      Back to Documents
                    </Link>
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          </main>
        </div>
      </AuthGuard>
    );
  }

  const nonReadyDocuments = documents.filter((document) => document.status && document.status !== "ready");

  return (
    <AuthGuard>
      <div className="flex min-h-screen bg-background">
        <AppSidebar />

        <main
          className="flex-1 transition-[padding] duration-300"
          style={{ paddingLeft: "var(--sidebar-width, 256px)" }}
        >
          <div className="flex h-screen flex-col gap-5 p-6">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <Button asChild variant="ghost" size="sm" className="-ml-3 w-fit gap-2">
                  <Link href="/documents">
                    <ArrowLeft className="size-4" />
                    Documents
                  </Link>
                </Button>

                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Multi-document Chat
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    Ask questions across selected documents
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="size-3" />
                  {selectedDocumentIds.length} sources selected
                </Badge>
                {messages.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setMessages([]);
                      setChatError("");
                    }}
                    className="gap-2"
                  >
                    <X className="size-4" />
                    Clear chat
                  </Button>
                )}
              </div>
            </header>

            <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
              <aside className="min-h-0">
                <Card className="flex h-full flex-col border-border bg-muted/20">
                  <div className="border-b border-border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold">Sources</h2>
                        <p className="text-xs text-muted-foreground">
                          Selected document set
                        </p>
                      </div>
                      <Badge variant="outline" className="font-mono text-xs">
                        {documents.length}/{selectedDocumentIds.length}
                      </Badge>
                    </div>
                  </div>

                  <ScrollArea className="flex-1">
                    <div className="space-y-3 p-4">
                      {metadataLoading && (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-background/70 p-3 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          Loading sources...
                        </div>
                      )}

                      {metadataError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                          {metadataError}
                        </div>
                      )}

                      {missingDocumentIds.length > 0 && (
                        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-300">
                          {missingDocumentIds.length} selected document(s) could not be loaded or are not accessible.
                        </div>
                      )}

                      {nonReadyDocuments.length > 0 && (
                        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-300">
                          Some selected documents are not ready yet. The backend may reject questions until processing finishes.
                        </div>
                      )}

                      {documents.map((document) => (
                        <Link
                          key={document._id}
                          href={`/documents/${document._id}`}
                          className="block rounded-lg border border-border bg-background/80 p-3 transition-colors hover:border-primary/60 hover:bg-primary/10"
                        >
                          <div className="flex items-start gap-3">
                            <div className="rounded-md bg-muted p-2">
                              <FileText className="size-4 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <p className="truncate text-sm font-medium">
                                  {document.title || "Untitled"}
                                </p>
                                <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Badge variant={document.status === "ready" ? "secondary" : "outline"} className="text-[11px]">
                                  {document.status || "ready"}
                                </Badge>
                                {document.fileType && (
                                  <Badge variant="outline" className="text-[11px]">
                                    {document.fileType}
                                  </Badge>
                                )}
                                {typeof document.chunkCount === "number" && (
                                  <Badge variant="outline" className="text-[11px] font-mono">
                                    {document.chunkCount} chunks
                                  </Badge>
                                )}
                                {document.size && (
                                  <Badge variant="outline" className="text-[11px]">
                                    {formatSize(document.size)}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </ScrollArea>
                </Card>
              </aside>

              <Card className="flex min-h-0 flex-col overflow-hidden border-border bg-muted/20">
                <div className="border-b border-border bg-background/70 px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="rounded-md bg-primary/10 p-2 text-primary">
                      <MessageSquare className="size-5" />
                    </div>
                    <div>
                      <h2 className="text-sm font-semibold">Workspace chat</h2>
                      <p className="text-xs text-muted-foreground">
                        Answers cite the selected source documents
                      </p>
                    </div>
                  </div>
                </div>

                <ScrollArea className="flex-1 px-5 py-5">
                  {messages.length === 0 && !chatLoading && (
                    <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                      <div className="mb-4 rounded-full border border-primary/20 bg-primary/10 p-3 text-primary">
                        <Bot className="size-7" />
                      </div>
                      <h3 className="text-lg font-semibold">Start with your sources</h3>
                      <p className="mt-2 max-w-md text-sm text-muted-foreground">
                        Ask for a summary, compare themes, or look for gaps across the selected documents.
                      </p>

                      <div className="mt-6 grid w-full max-w-3xl gap-3 md:grid-cols-3">
                        {suggestedPrompts.map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            onClick={() => setInput(prompt)}
                            className="rounded-lg border border-border bg-background/80 p-4 text-left text-sm transition-colors hover:border-primary/60 hover:bg-primary/10"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-7">
                    {messages.map((message, index) => {
                      const isUser = message.role === "user";

                      return (
                        <div
                          key={`${message.role}-${index}`}
                          className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}
                        >
                          {!isUser && (
                            <Avatar className="mt-1">
                              <AvatarFallback>
                                <Bot size={16} />
                              </AvatarFallback>
                            </Avatar>
                          )}

                          <div className={`flex max-w-3xl flex-col ${isUser ? "items-end" : "items-start"}`}>
                            <div
                              className={`rounded-xl border px-5 py-4 text-sm leading-relaxed ${
                                isUser
                                  ? "border-primary/20 bg-primary/10"
                                  : "border-border bg-background"
                              }`}
                            >
                              <div className="prose prose-invert max-w-none text-sm">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {message.content}
                                </ReactMarkdown>
                              </div>
                            </div>

                            {!isUser && (
                              <div className="mt-3 flex w-full flex-col gap-3">
                                {message.sources && message.sources.length > 0 && (
                                  <div className="rounded-lg border border-border bg-background/70 p-3">
                                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                      Sources
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {message.sources.map((source) => (
                                        <Link
                                          key={`${source.documentId}-${source.chunkIndex}`}
                                          href={`/documents/${source.documentId}`}
                                          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs transition-colors hover:border-primary/60 hover:bg-primary/10"
                                        >
                                          <span className="block max-w-52 truncate font-medium">
                                            {source.title || "Untitled"}
                                          </span>
                                          <span className="text-muted-foreground">
                                            Chunk {source.chunkIndex}
                                            {formatScore(source.score) ? ` | Score ${formatScore(source.score)}` : ""}
                                          </span>
                                        </Link>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => copyText(message.content)}
                                  className="w-fit gap-2 opacity-70 hover:opacity-100"
                                >
                                  <Copy className="size-3.5" />
                                  Copy
                                </Button>
                              </div>
                            )}
                          </div>

                          {isUser && (
                            <Avatar className="mt-1">
                              <AvatarFallback>
                                <User size={16} />
                              </AvatarFallback>
                            </Avatar>
                          )}
                        </div>
                      );
                    })}

                    {chatLoading && (
                      <div className="flex gap-4">
                        <Avatar>
                          <AvatarFallback>
                            <Bot size={16} />
                          </AvatarFallback>
                        </Avatar>
                        <div className="rounded-xl border border-border bg-background px-5 py-4 text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <Loader2 className="size-4 animate-spin" />
                            Reading across selected sources...
                          </div>
                        </div>
                      </div>
                    )}

                    <div ref={bottomRef} />
                  </div>
                </ScrollArea>

                {chatError && (
                  <div className="border-t border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive">
                    {chatError}
                  </div>
                )}

                <div className="border-t border-border bg-background p-4">
                  <label htmlFor="multi-document-question" className="sr-only">
                    Ask a question across selected documents
                  </label>
                  <div className="flex flex-col gap-3 md:flex-row md:items-end">
                    <Textarea
                      id="multi-document-question"
                      value={input}
                      disabled={chatLoading}
                      placeholder="Compare the key ideas across these documents..."
                      className="max-h-40 min-h-20 resize-none"
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                          e.preventDefault();
                          submitQuestion();
                        }
                      }}
                    />
                    <Button
                      onClick={() => submitQuestion()}
                      disabled={chatLoading || !input.trim()}
                      className="gap-2 md:h-20 md:px-5"
                    >
                      {chatLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                      Send
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}

export default function MultiDocumentChatPage() {
  return (
    <Suspense fallback={null}>
      <MultiDocumentChatContent />
    </Suspense>
  );
}
