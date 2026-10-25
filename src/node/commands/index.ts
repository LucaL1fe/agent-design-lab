// Registers every command. Each file calls register() at import time; `adl help` lists them in this order.
import './basic.ts';
import './project.ts';
import './edit.ts';
import './check.ts';
import './render.ts';
import './handoff.ts';
import './setup.ts';
import './importer.ts';
