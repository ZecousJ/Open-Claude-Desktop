import { z } from "zod";

export const desktopNotificationInput = z
  .object({
    title: z.string().min(1).max(500),
    body: z.string().max(5000),
    tag: z.string().min(1).max(200).optional(),
    conversationId: z.string().min(1).max(200).optional(),
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    actions: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z][a-z0-9_]{0,31}$/)
              .refine(
                (id) =>
                  ![
                    "click",
                    "close",
                    "dismiss",
                    "timeout",
                    "allow_once",
                  ].includes(id),
              ),
            title: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.actions?.length &&
      (!input.tag ||
        !input.token ||
        new Set(input.actions.map((action) => action.id)).size !==
          input.actions.length)
    )
      context.addIssue({
        code: "custom",
        message: "INVALID_NOTIFICATION_ACTIONS",
      });
  });
