import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { readStoredEmbeddingIdentity } from './stored-embedding-identity.ts';
import { splitEmbeddingSignature } from './embedding-invalidation.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import { resolveSchemaEmbeddingDim } from './embedding-dim-check.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine } from './search/embedding-column.ts';

export type EmbeddingIdentityResolution =
  | { state: 'disabled' }
  | { state: 'configured'; model: string; dimensions?: number }
  | { state: 'recovered'; model: string; dimensions: number; signature: string | null }
  | { state: 'unverified'; reason: string };

type IdentityReader = Pick<BrainEngine, 'executeRaw' | 'getConfig'>;
export interface ResolveEmbeddingIdentityOptions {
  /** Mounts keep their publisher's DB-plane model out of the caller's gateway. */
  allowDbRecovery?: boolean;
}

function providerModelIdentity(model: string): { key: string; modelId: string } {
  const { parsed, recipe } = resolveRecipe(model);
  if (!recipe.touchpoints.embedding) throw new Error(`Provider ${parsed.providerId} has no embedding model support.`);
  return { key: `${parsed.providerId}:${parsed.modelId}`, modelId: parsed.modelId };
}

function modelMatchesIdentity(model: string, identity: { key: string; modelId: string }): boolean {
  const candidate = model.trim();
  if (!candidate) return false;
  if (!candidate.includes(':') && !candidate.includes('/')) return candidate === identity.modelId;
  try {
    return providerModelIdentity(candidate).key === identity.key;
  } catch {
    return false;
  }
}

function parseDimensions(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(value)) return NaN;
  const dimensions = Number(value);
  return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : NaN;
}

function unverified(reason: string): EmbeddingIdentityResolution {
  return { state: 'unverified', reason };
}

/** Resolve the current operator choice, or recover a DB-only identity from the stored schema and any vector provenance. */
export async function resolveEmbeddingIdentity(
  engine: IdentityReader,
  config: Pick<GBrainConfig, 'embedding_disabled' | 'embedding_model' | 'embedding_dimensions'> | null,
  options: ResolveEmbeddingIdentityOptions = {},
): Promise<EmbeddingIdentityResolution> {
  if (config?.embedding_disabled === true) return { state: 'disabled' };

  let dbDisabled: string | null = null;
  let dbDisableReadFailed = false;
  try {
    dbDisabled = await engine.getConfig('embedding_disabled');
  } catch { dbDisableReadFailed = true; }
  if (dbDisabled === 'true') return { state: 'disabled' };

  const configuredModel = config?.embedding_model?.trim();
  if (configuredModel) {
    return { state: 'configured', model: configuredModel, dimensions: config?.embedding_dimensions };
  }
  if (dbDisableReadFailed) return unverified('The DB-plane embedding_disabled choice could not be read.');

  const configuredDimensions = config?.embedding_dimensions;
  if (configuredDimensions !== undefined && (!Number.isSafeInteger(configuredDimensions) || configuredDimensions <= 0)) {
    return unverified('The explicit file/environment embedding_dimensions value is not a positive integer.');
  }
  if (options.allowDbRecovery === false) {
    return unverified('This mounted brain does not select the caller gateway model from its DB plane. Set an explicit file/environment embedding_model or keep embeddings disabled.');
  }

  let dbModel: string | null;
  let dbDimensionsRaw: string | null;
  try {
    [dbModel, dbDimensionsRaw] = await Promise.all([
      engine.getConfig('embedding_model'),
      engine.getConfig('embedding_dimensions'),
    ]);
  } catch {
    return unverified('The DB-plane embedding model or dimensions could not be read.');
  }
  dbModel = dbModel?.trim() || null;
  if (!dbModel) {
    return unverified('No embedding_model is configured in the file/environment or DB plane.');
  }

  let activeColumn: Awaited<ReturnType<typeof resolveActiveEmbeddingColumnFromEngine>>;
  try {
    activeColumn = await resolveActiveEmbeddingColumnFromEngine(engine);
  } catch (error) {
    return unverified(`The active content_chunks embedding column could not be resolved: ${(error as Error).message}`);
  }

  let stored: Awaited<ReturnType<typeof readStoredEmbeddingIdentity>>;
  try {
    stored = await readStoredEmbeddingIdentity(engine, activeColumn.name);
  } catch (error) {
    return unverified(`The stored active embedding column could not be verified: ${(error as Error).message}`);
  }
  if (!stored) return unverified(`The stored content_chunks.${activeColumn.name} embedding column is not available to verify.`);
  const storedDimensions = stored.dimensions;

  const dbDimensions = parseDimensions(dbDimensionsRaw);
  if (Number.isNaN(dbDimensions)) {
    return unverified('The DB-plane embedding_dimensions value is not a positive integer.');
  }
  if (dbDimensions !== null && dbDimensions !== storedDimensions) {
    return unverified(`DB embedding_dimensions is ${dbDimensions}, but the stored content_chunks column is vector(${storedDimensions}).`);
  }
  if (configuredDimensions !== undefined && configuredDimensions !== storedDimensions) {
    return unverified(`The explicit file/environment embedding_dimensions value is ${configuredDimensions}, but the stored content_chunks column is vector(${storedDimensions}).`);
  }

  let vectorProvenance: Array<{ signature: string | null; chunkModel: string | null }>;
  try {
    // Existing vectors are evidence for the brain-wide identity; a stale page stamp must not establish it.
    vectorProvenance = await engine.executeRaw<{ signature: string | null; chunkModel: string | null }>(`
      SELECT DISTINCT p.embedding_signature AS signature, cc.model AS "chunkModel"
        FROM content_chunks cc
        LEFT JOIN pages p ON p.id = cc.page_id
       WHERE cc.${quoteIdentifier(activeColumn.name)} IS NOT NULL
       ORDER BY p.embedding_signature, cc.model
    `);
  } catch (error) {
    return unverified(`Stored page embedding signatures on content_chunks.${activeColumn.name} could not be read: ${(error as Error).message}`);
  }

  let recoveredModel = dbModel;
  let signature: string | null = null;
  const signatures = [...new Set(vectorProvenance.map(row => row.signature))];
  if (signatures.length > 1) {
    return unverified('Stored vectors have more than one page embedding_signature.');
  }
  if (signatures.length === 1) {
    const stampedSignature = signatures[0];
    if (!stampedSignature) {
      return unverified('Stored vector chunks have no page embedding_signature.');
    }
    signature = stampedSignature;
    const parsedSignature = splitEmbeddingSignature(signature);
    if (parsedSignature.dims === null) {
      return unverified(`Stored page embedding_signature "${signature}" has no valid dimensions.`);
    }
    if (parsedSignature.dims !== storedDimensions) {
      return unverified(`Stored page embedding_signature is ${parsedSignature.dims}d, but the content_chunks column is vector(${storedDimensions}).`);
    }

    let signatureIdentity: { key: string; modelId: string };
    try {
      signatureIdentity = providerModelIdentity(parsedSignature.model);
    } catch (error) {
      return unverified(`Stored embedding model identity is invalid: ${(error as Error).message}`);
    }
    if (!modelMatchesIdentity(dbModel, signatureIdentity)) {
      return unverified(`DB embedding_model "${dbModel}" conflicts with stored page embedding_signature "${signature}".`);
    }
    for (const row of vectorProvenance) {
      if (!row.chunkModel?.trim()) {
        return unverified('Vector-bearing chunks have no content_chunks.model provenance.');
      }
      if (!modelMatchesIdentity(row.chunkModel, signatureIdentity)) {
        return unverified(`Stored content_chunks.model "${row.chunkModel}" conflicts with stored page embedding_signature "${signature}".`);
      }
    }
    const supported = resolveSchemaEmbeddingDim({
      embedding_model: parsedSignature.model,
      embedding_dimensions: parsedSignature.dims,
    });
    if (!supported.ok || supported.dim !== storedDimensions) {
      return unverified(`Stored embedding model "${parsedSignature.model}" does not support the stored ${storedDimensions}d column.`);
    }
    recoveredModel = parsedSignature.model;
  } else if (dbModel.includes(':') || dbModel.includes('/')) {
    try {
      providerModelIdentity(dbModel);
    } catch (error) {
      return unverified(`DB embedding_model "${dbModel}" is invalid: ${(error as Error).message}`);
    }
    const supported = resolveSchemaEmbeddingDim({ embedding_model: dbModel, embedding_dimensions: storedDimensions });
    if (!supported.ok || supported.dim !== storedDimensions) {
      return unverified(`DB embedding_model "${dbModel}" does not support the stored ${storedDimensions}d column.`);
    }
  } else {
    return unverified(`DB embedding_model "${dbModel}" has no provider prefix and no stored vector signature identifies its provider.`);
  }

  return { state: 'recovered', model: recoveredModel, dimensions: storedDimensions, signature };
}
