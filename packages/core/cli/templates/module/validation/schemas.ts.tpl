import { z } from "zod";

export const create{{NameSingular}}Schema = z
  .object({
    name: z.string().min(1).max(200),
  })
  .strict();

export const update{{NameSingular}}Schema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export const {{nameSingular}}IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const list{{NamePlural}}QuerySchema = z
  .object({
    search: z.string().min(1).optional(),
    page: z.coerce.number().int().positive().default(1),
    perPage: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

export type Create{{NameSingular}}Input = z.infer<typeof create{{NameSingular}}Schema>;
export type Update{{NameSingular}}Input = z.infer<typeof update{{NameSingular}}Schema>;
export type {{NameSingular}}IdParam = z.infer<typeof {{nameSingular}}IdParamSchema>;
export type List{{NamePlural}}Query = z.infer<typeof list{{NamePlural}}QuerySchema>;
