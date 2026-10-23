/** A synchronous generation fence. Changing screen/input invalidates every old async reply. */
export class RequestScope {
  private generation = 0;
  current(): number { return this.generation; }
  invalidate(): number { return ++this.generation; }
  accepts(generation: number): boolean { return generation === this.generation; }
}
