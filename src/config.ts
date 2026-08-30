import { z } from "zod";

export const ConfigContextSchema = z
  .object({
    show: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to show context usage in the session sidebar."),
    warn_on_usage: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .default(80)
      .describe("Warn when % usage reaches this value."),
    warn_on_count: z
      .int()
      .min(0)
      .optional()
      .default(120_000)
      .describe("Warn when token count reaches this value."),
  })
  .strict();

export const ConfigModelsSchema = z
  .object({
    show: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to show model usage in the session sidebar."),
  })
  .strict();

export const ConfigSchema = z
  .object({
    include_subagents: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include subagents in token calculation."),
    context: ConfigContextSchema.optional()
      .default(ConfigContextSchema.parse({}))
      .describe(
        "Configure the context section in the session sidebar. Use to replace the built-in context section.",
      ),
    models: ConfigModelsSchema.optional()
      .default(ConfigModelsSchema.parse({}))
      .describe("Configure the models section in the session sidebar."),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
