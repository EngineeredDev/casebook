/**
 * Turning a path into a page, which is the half of the router that can be wrong
 * without anything on screen looking wrong: every route resolves to a component
 * and a bad resolution just renders a different page.
 *
 * `parseRoute` is a pure function over a string, so it needs no DOM — the rest
 * of router.tsx reaches for `window`, but only inside functions, so importing
 * the module here costs nothing.
 */

import { describe, expect, it } from "vitest";
import { parseRoute, studentPath } from "./router.tsx";

describe("parseRoute", () => {
  it("sends the bare path to the Log, which is where the app opens", () => {
    expect(parseRoute("/")).toEqual({ page: "log" });
    expect(parseRoute("")).toEqual({ page: "log" });
  });

  it("tells the roster apart from one student", () => {
    expect(parseRoute("/students")).toEqual({ page: "students" });
    expect(parseRoute("/students/s-ada")).toEqual({ page: "student", studentId: "s-ada" });
  });

  it("gets an id back out of the path it wrote", () => {
    // The pair has to survive a round trip, since ids are opaque and nothing
    // downstream would notice a mangled one until a student's page came up empty.
    expect(parseRoute(studentPath("s ada/#1"))).toEqual({
      page: "student",
      studentId: "s ada/#1",
    });
  });

  it("answers Not found for an address that matches nothing", () => {
    expect(parseRoute("/nowhere")).toEqual({ page: "notFound" });
  });

  it("answers Not found rather than throwing on a half-written escape", () => {
    // decodeURIComponent throws a URIError on "%E0" with nothing after it, and
    // this runs inside render — so before the guard, one malformed link
    // anywhere in the app replaced the whole window with a blank screen in an
    // app that has no address bar to type a different path into.
    expect(parseRoute("/students/%E0")).toEqual({ page: "notFound" });
    expect(parseRoute("/students/100%")).toEqual({ page: "notFound" });
  });
});
