const Document = require("../models/document.model");
const DocumentChunk = require("../models/documentChunk.model");

const { runEmbedding } = require("../agents/embeddingAdapter");

const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

function safeProcessingError(error) {

    if (!error) return "Document processing failed";

    const message = error instanceof Error
        ? error.message
        : String(error);

    return message.slice(0, 500) || "Document processing failed";
}

function chunkText(text, chunkSize = 1200, overlap = 200) {

    const chunks = [];

    let start = 0;

    while (start < text.length) {

        const end = start + chunkSize;

        const piece = text.slice(start, end).trim();

        if (piece) chunks.push(piece);

        start += chunkSize - overlap;
    }

    return chunks;
}

function cosineSimilarity(vecA, vecB) {

    if (vecA.length !== vecB.length) return 0;

    let dot = 0, normA = 0, normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (!normA || !normB) return 0;

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function isComparisonQuery(query) {

    const normalizedQuery = (query || "").toLowerCase();

    return [
        "compare",
        "contrast",
        "difference",
        "differences",
        "similar",
        "similarities",
        "both",
        "all documents",
        "across documents"
    ].some(term => normalizedQuery.includes(term));
}

function getChunkKey(chunk) {

    return chunk._id
        ? chunk._id.toString()
        : `${chunk.documentId.toString()}:${chunk.chunkIndex}`;
}

function selectBalancedChunks(scoredChunks, documentIds, limit, query) {

    const chunksByDocumentId = new Map();

    for (const chunk of scoredChunks) {
        const documentId = chunk.documentId.toString();

        if (!chunksByDocumentId.has(documentId)) {
            chunksByDocumentId.set(documentId, []);
        }

        chunksByDocumentId.get(documentId).push(chunk);
    }

    for (const chunks of chunksByDocumentId.values()) {
        chunks.sort((a, b) => b.score - a.score);
    }

    const selectedChunks = [];
    const seenChunkKeys = new Set();

    const addChunk = (chunk) => {
        if (!chunk) return;

        const chunkKey = getChunkKey(chunk);

        if (seenChunkKeys.has(chunkKey)) return;

        seenChunkKeys.add(chunkKey);
        selectedChunks.push(chunk);
    };

    // Balanced retrieval applies to every multi-document query; comparison detection keeps the intent explicit.
    const shouldPrioritizeCoverage = documentIds.length > 1 || isComparisonQuery(query);

    if (!shouldPrioritizeCoverage) {
        return scoredChunks.slice(0, limit);
    }

    for (const documentId of documentIds.map(id => id.toString())) {
        addChunk(chunksByDocumentId.get(documentId)?.[0]);
    }

    // For multi-document comparison, source coverage is prioritized over strict topK.
    if (selectedChunks.length >= limit) {
        return selectedChunks;
    }

    for (const chunk of scoredChunks) {
        if (selectedChunks.length >= limit) break;
        addChunk(chunk);
    }

    return selectedChunks;
}

async function processDocument(agent, document, text) {

    try {
        await Document.findByIdAndUpdate(document._id, {
            processingStep: "Chunking"
        });

        const chunks = chunkText(text);

        await Document.findByIdAndUpdate(document._id, {
            processingStep: "Embedding chunks",
            processedChunks: 0,
            totalChunks: chunks.length
        });

        const records = [];

        for (let i = 0; i < chunks.length; i++) {

            const content = chunks[i];

            const embedding = await runEmbedding(content, agent);

            records.push({
                documentId: document._id,
                userId: document.userId,
                chunkIndex: i,
                content,
                embedding
            });

            await Document.updateOne(
                {
                    _id: document._id,
                    status: "processing"
                },
                {
                    processedChunks: i + 1
                }
            );
        }

        const currentDocument = await Document.findById(document._id)
            .select("status")
            .lean();

        if (!currentDocument || currentDocument.status !== "processing") {
            throw new Error("Document processing was interrupted");
        }

        await DocumentChunk.insertMany(records);

        await Document.updateOne(
            {
                _id: document._id,
                status: "processing"
            },
            {
                $set: {
                    status: "ready",
                    processingStep: "Ready",
                    processedAt: new Date(),
                    processedChunks: records.length,
                    totalChunks: records.length,
                    chunkCount: records.length
                },
                $unset: { processingError: "" }
            }
        );
    } catch (error) {
        await DocumentChunk.deleteMany({
            documentId: document._id
        });

        await Document.findByIdAndUpdate(document._id, {
            status: "failed",
            processingStep: "Failed",
            processingError: safeProcessingError(error),
            processedAt: new Date()
        });

        throw error;
    }
}

async function markStaleProcessingDocumentsAsFailed() {

    const staleBefore = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);

    return Document.updateMany(
        {
            status: "processing",
            $or: [
                { processingStartedAt: { $lt: staleBefore } },
                { processingStartedAt: { $exists: false } }
            ]
        },
        {
            status: "failed",
            processingStep: "Failed",
            processingError: "Processing was interrupted or timed out",
            processedAt: new Date()
        }
    );
}

async function queryDocument(agent, userId, documentId, query, topK = 3) {

    return queryDocuments(agent, userId, [documentId], query, topK);
}

async function queryDocuments(agent, userId, documentIds, query, topK = 3) {

    const parsedTopK = Number(topK);
    const limit = Number.isFinite(parsedTopK)
        ? Math.max(0, Math.floor(parsedTopK))
        : 3;

    const uniqueDocumentIds = [...new Map(
        (Array.isArray(documentIds) ? documentIds : [])
            .filter(Boolean)
            .map(id => [id.toString(), id])
    ).values()];

    if (!uniqueDocumentIds.length) {
        return [];
    }

    // Generate embedding for the query
    const queryEmbedding = await runEmbedding(query, agent);

    // Fetch only the chunks from the selected documents
    const chunks = await DocumentChunk.find({
        userId,
        documentId: { $in: uniqueDocumentIds }
    })
        .select("documentId chunkIndex content embedding") // load only required fields
        .lean();

    if (!chunks.length) {
        return [];
    }

    // Compute cosine similarity
    const scored = chunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    // Sort by similarity score
    scored.sort((a, b) => b.score - a.score);

    if (uniqueDocumentIds.length === 1) {
        // Return topK results
        return scored.slice(0, limit);
    }

    return selectBalancedChunks(scored, uniqueDocumentIds, limit, query);
}

module.exports = {
    processDocument,
    queryDocument,
    queryDocuments,
    markStaleProcessingDocumentsAsFailed,
    STALE_PROCESSING_THRESHOLD_MS
};
