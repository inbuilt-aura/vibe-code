import { serve } from "inngest/next";
import { inngest } from "../../../inngest/client";
import {
  runGrokAgent,
  helloWorld,
  sandboxFunction,
  runCodeWithSandbox,  
} from "../../../inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    runGrokAgent,
    helloWorld,
    sandboxFunction,
    runCodeWithSandbox,  
  ],
});
