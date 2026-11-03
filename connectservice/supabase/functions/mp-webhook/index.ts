import { handleWebhook } from '../_shared/handlers.ts';
import { buildContext } from '../_shared/context.ts';

Deno.serve((req) => handleWebhook(req, buildContext()));
