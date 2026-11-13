import { z } from 'zod';
import { digest, id } from './sync-wire.js';

const file = z.object({
  path: z.string().min(1).max(1024),
  bytes: z.number().int().nonnegative(),
  sha256: digest,
  executable: z.boolean(),
});
const heads = z
  .array(id)
  .min(1)
  .max(32)
  .refine((items) => new Set(items).size === items.length);
const ref = z.object({ vaultId: id, entityId: id });
const binding = z.object({
  targetId: z.string().min(1).max(128),
  path: z.string().max(4096),
  revision: id.optional(),
  fingerprint: digest,
  pending: z
    .object({ opId: id, state: z.enum(['prepared', 'applying', 'conflict']), paused: z.boolean() })
    .optional(),
});
const version = z.object({
  opId: id,
  parents: z.array(id).max(32),
  name: z.string().max(256),
  deleted: z.boolean(),
  files: z.array(file).max(100),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export const BundleMethodSchemas = {
  'sync.cancelBundle': {
    params: ref,
    result: z.object({ cancelled: z.literal(true) }),
    permission: 'host.manage',
  },
  'sync.bundleVaults': {
    params: z.object({}),
    result: z.object({
      vaults: z
        .array(
          z.object({
            vaultId: id,
            active: z.boolean(),
            projects: z.array(z.string().max(256)).max(2),
            lastSyncAt: z.iso.datetime().optional(),
          }),
        )
        .max(100),
    }),
    permission: 'host.manage',
  },
  'sync.bundles': {
    params: z.object({ vaultId: id, after: id.optional() }),
    result: z.object({
      bundles: z
        .array(
          z.object({
            entityId: id,
            category: z.enum(['rule', 'skill-bundle', 'artifact']),
            name: z.string().max(256),
            heads,
            projectId: id.optional(),
            binding: binding.optional(),
          }),
        )
        .max(100),
      next: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.bundlePreview': {
    params: ref.extend({
      fileOffset: z.number().int().min(0).max(10000).optional(),
      opId: id.optional(),
    }),
    result: z.object({
      vaultId: id,
      entityId: id,
      heads,
      versions: z.array(version).min(1).max(32),
      binding: binding.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.bundleTargets': {
    params: ref,
    result: z.object({
      targets: z
        .array(
          z.object({
            targetId: z.string().min(1).max(128),
            name: z.string().max(256),
            path: z.string().max(4096),
            fingerprint: digest,
            kind: z.enum(['file', 'directory']),
            managed: z.boolean(),
          }),
        )
        .max(1000),
    }),
    permission: 'host.manage',
  },
  'sync.bundleVersions': {
    params: ref.extend({ after: id.optional() }),
    result: z.object({ versions: z.array(version).max(100), next: id.optional() }),
    permission: 'host.manage',
  },
  'sync.keepLocalBundle': {
    params: ref.extend({
      expectedHeads: heads,
      targetId: z.string().min(1).max(128),
      fingerprint: digest,
      localRevision: id.optional(),
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
  'sync.applyBundle': {
    params: ref.extend({
      expectedHeads: heads,
      selectedOpId: id,
      targetId: z.string().min(1).max(128),
      fingerprint: digest,
      localRevision: id.optional(),
      expectedTargetId: z.string().min(1).max(128).optional(),
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
  'sync.bundleFile': {
    params: ref.extend({ opId: id.optional(), path: z.string().min(1).max(1024) }),
    result: z.object({
      path: z.string().max(1024),
      sha256: digest,
      bytes: z.number().int().nonnegative(),
      text: z
        .string()
        .max(128 * 1024)
        .optional(),
      binary: z.boolean(),
      truncated: z.boolean(),
      fingerprint: digest.optional(),
      localRevision: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.editBundleFile': {
    params: ref.extend({
      path: z.string().min(1).max(1024),
      text: z
        .string()
        .max(128 * 1024)
        .optional(),
      deleted: z.boolean().optional(),
      fingerprint: digest,
      localRevision: id.optional(),
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
  'sync.retryBundle': {
    params: ref.extend({ opId: id }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
} as const;
