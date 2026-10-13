# Chunking Library - Documentation Index

Complete guide to all documentation in the chunking library.

## 📚 Documentation Overview

| Document | Description | When to Read |
|----------|-------------|--------------|
| **[README.md](../README.md)** | Complete library overview | First read, reference |
| **[quick-start.md](quick-start.md)** | Get started in 5 minutes | Start here! |
| **[strategies.md](strategies.md)** | Strategy deep dive & comparison | Choosing a strategy |
| **[api-reference.md](api-reference.md)** | Complete API documentation | API integration |
| **[configuration.md](configuration.md)** | Configuration & tuning | Optimizing performance |
| **[code-organization.md](code-organization.md)** | Code structure & patterns | Contributing / extending |
| **[troubleshooting.md](troubleshooting.md)** | Common issues & solutions | When things break |
| **[best-practices.md](best-practices.md)** | Production best practices | Production deployment |

## 🎯 Documentation by Role

### For Developers (Using the Library)

**Start here:**
1. [quick-start.md](quick-start.md) - Basic usage (5 min)
2. [strategies.md](strategies.md) - Choose the right strategy
3. [api-reference.md](api-reference.md) - Full API reference

**Common tasks:**
- [Create a chunking service](quick-start.md#-quick-start)
- [Chunk a document](quick-start.md#2-chunk-your-text)
- [Switch strategies](api-reference.md#setstrategy)
- [Configure token limits](configuration.md#token-limits)

### For AI/ML Engineers (RAG & Embeddings)

**Start here:**
1. [strategies.md](strategies.md) - Strategy comparison & selection
2. [configuration.md](configuration.md) - Tuning for your use case
3. [best-practices.md](best-practices.md) - Production optimization

**Common tasks:**
- [Choose the right strategy](strategies.md#-strategy-comparison)
- [Optimize chunk size for embeddings](configuration.md#embedding-model-alignment)
- [Handle different content types](strategies.md#content-type-recommendations)
- [Measure chunking quality](configuration.md#quality-metrics)

### For Contributors (Extending the Library)

**Start here:**
1. [code-organization.md](code-organization.md) - Architecture & patterns
2. [api-reference.md](api-reference.md) - Interface contracts
3. [strategies.md](strategies.md) - Existing implementations

**Common tasks:**
- [Understand the architecture](code-organization.md#architecture)
- [Create a custom strategy](code-organization.md#creating-a-custom-strategy)
- [Run tests](code-organization.md#testing)
- [Follow conventions](code-organization.md#conventions)

## 📖 Documentation by Task

### Getting Started
| Task | Documentation |
|------|---------------|
| Install the library | [quick-start.md](quick-start.md#1-install) |
| First chunking example | [quick-start.md](quick-start.md#2-chunk-your-text) |
| Understand the output | [quick-start.md](quick-start.md#3-understand-the-output) |
| Clean up resources | [quick-start.md](quick-start.md#4-clean-up) |

### Choosing a Strategy
| Task | Documentation |
|------|---------------|
| Compare strategies | [strategies.md](strategies.md#-strategy-comparison) |
| Use Fixed Length | [strategies.md](strategies.md#fixed-length-strategy) |
| Use Sliding Window | [strategies.md](strategies.md#sliding-window-strategy) |
| Use Semantic (recommended) | [strategies.md](strategies.md#semantic-strategy) |
| Match strategy to content | [strategies.md](strategies.md#content-type-recommendations) |

### Configuration & Tuning
| Task | Documentation |
|------|---------------|
| Set token limits | [configuration.md](configuration.md#token-limits) |
| Choose token encoding | [configuration.md](configuration.md#token-encodings) |
| Tune overlap settings | [configuration.md](configuration.md#overlap-configuration) |
| Optimize for performance | [configuration.md](configuration.md#performance-tuning) |
| Align with embedding models | [configuration.md](configuration.md#embedding-model-alignment) |

### Advanced Topics
| Task | Documentation |
|------|---------------|
| Switch strategies at runtime | [api-reference.md](api-reference.md#setstrategy) |
| Use auto-detection factory | [api-reference.md](api-reference.md#static-create) |
| Handle edge cases | [troubleshooting.md](troubleshooting.md) |
| Production deployment | [best-practices.md](best-practices.md) |
| Create a custom strategy | [code-organization.md](code-organization.md#creating-a-custom-strategy) |

### Testing & Development
| Task | Documentation |
|------|---------------|
| Run tests | [code-organization.md](code-organization.md#testing) |
| Write strategy tests | [code-organization.md](code-organization.md#writing-tests) |
| Mock the service | [code-organization.md](code-organization.md#mocking) |

## 🔍 Quick Reference

### Key Concepts

- **[Strategy Pattern](strategies.md#architecture)** - Pluggable chunking algorithms
- **[Token Counting](configuration.md#token-encodings)** - Accurate token measurement with tiktoken
- **[Semantic Boundaries](strategies.md#semantic-strategy)** - Structure-aware chunking
- **[Chunk Overlap](configuration.md#overlap-configuration)** - Context preservation between chunks

### Strategies at a Glance

| Strategy | Best For | Speed | Quality |
|----------|----------|-------|---------|
| **Fixed Length** | Prototyping, uniform text | Fastest | Basic |
| **Sliding Window** | Narrative content, context overlap | Medium | Good |
| **Semantic** | Production RAG, structured docs | Slower | Best |

### Factory Methods

```typescript
// Quick creation
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
const service = ChunkingService.createWithSlidingWindow({ maxTokens: 512, overlapTokens: 80 });
const service = ChunkingService.createWithFixedLength({ maxTokens: 512 });

// Auto-detection
const service = ChunkingService.create(options);
```

### Common Configuration

```typescript
// Production RAG (recommended)
{ maxTokens: 512, minTokens: 100, mergeSmallChunks: true }

// Narrative content with overlap
{ maxTokens: 512, overlapTokens: 80, preferParagraphBoundaries: true }

// Fast prototyping
{ maxTokens: 512 }
```

## 📝 Documentation Structure

```
libraries/chunking/
├── 📖 README.md                    Library overview & entry point
│
├── docs/
│   ├── 📚 index.md                 This file - navigation hub
│   ├── 📝 summary.md               Quick reference card
│   ├── 🚀 quick-start.md           5-minute getting started
│   ├── 📖 api-reference.md         Complete API documentation
│   ├── 🎯 strategies.md            Strategy deep dive
│   ├── ⚙️ configuration.md         Configuration & tuning
│   ├── 🏆 best-practices.md        Production best practices
│   ├── 🏗️ code-organization.md     Code structure & patterns
│   └── 🔧 troubleshooting.md       Common issues & solutions
│
├── ChunkingService.ts              Main service class
├── strategies/
│   ├── ChunkingStrategy.ts         Base strategy interface
│   ├── FixedLengthChunkingStrategy.ts
│   ├── SlidingWindowChunkingStrategy.ts
│   └── SemanticChunkingStrategy.ts
└── types/
    └── index.ts                    Type definitions
```

## 🆘 Need Help?

### Quick Answers

**Q: Which strategy should I use?**
A: Use **Semantic** for production RAG. See [strategies.md](strategies.md#-strategy-comparison)

**Q: How do I set chunk size?**
A: Use the `maxTokens` option. See [configuration.md](configuration.md#token-limits)

**Q: How do I handle large documents?**
A: All strategies handle large documents automatically. See [troubleshooting.md](troubleshooting.md#large-documents)

**Q: Do I need to call dispose()?**
A: Yes, always call `dispose()` when done. See [quick-start.md](quick-start.md#4-clean-up)

**Q: Can I switch strategies at runtime?**
A: Yes, use `setStrategy()`. See [api-reference.md](api-reference.md#setstrategy)

### Common Issues

| Issue | Solution |
|-------|----------|
| Empty chunks returned | [troubleshooting.md](troubleshooting.md#empty-chunks) |
| Token count mismatch | [troubleshooting.md](troubleshooting.md#token-count-mismatch) |
| Memory usage high | [troubleshooting.md](troubleshooting.md#memory-usage) |
| Chunks too small/large | [troubleshooting.md](troubleshooting.md#chunk-size-issues) |

## 🎓 Learning Path

### Beginner (Day 1)
1. Read [quick-start.md](quick-start.md)
2. Chunk your first document
3. Explore the output structure
4. Try different strategies

### Intermediate (Week 1)
1. Read [strategies.md](strategies.md)
2. Read [configuration.md](configuration.md)
3. Tune settings for your content type
4. Integrate with your embedding pipeline

### Advanced (Month 1)
1. Read [best-practices.md](best-practices.md)
2. Read [code-organization.md](code-organization.md)
3. Create custom strategies
4. Optimize for production workloads

## 📊 Documentation Stats

- **Total Pages:** 9 docs + README
- **Code Examples:** 50+
- **Quick Start Time:** 5 minutes
- **Full Read Time:** ~3 hours
- **Last Updated:** 2026-02-16

## 🔗 Related Resources

- [Ship-API Framework](../../../README.md)
- [Weaviate Library](../../weaviate/README.md)
- [tiktoken Documentation](https://github.com/openai/tiktoken)

---

**Pro Tip:** Bookmark this page and use it as your starting point for any chunking library questions!
