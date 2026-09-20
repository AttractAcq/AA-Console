import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdCreative } from "./ads.js";
import { adCreativePayload, imageHashFrom, uploadAdImage } from "./creative.js";

const account = { accessToken: "t", accountId: "act_1" };
const bytes = new Uint8Array([1, 2, 3]);

const copy = {
  primaryText: "Three slots left this month.",
  headline: "Book a check-up",
  link: "https://example.com/book",
  cta: "BOOK_NOW",
};

function respond(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(body) } as unknown as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe("reading the hash out of Meta's reply", () => {
  it("takes the one entry, whatever it is keyed by", () => {
    expect(imageHashFrom({ images: { "whatever.jpg": { hash: "abc" } } })).toBe("abc");
  });

  it("returns nothing for a reply it cannot read confidently", () => {
    expect(imageHashFrom({ images: {} })).toBeNull();
    expect(imageHashFrom({ images: { a: { hash: "1" }, b: { hash: "2" } } })).toBeNull();
    expect(imageHashFrom({ images: { a: {} } })).toBeNull();
    expect(imageHashFrom({ images: { a: { hash: "" } } })).toBeNull();
    expect(imageHashFrom({})).toBeNull();
    expect(imageHashFrom(null)).toBeNull();
  });
});

describe("uploading an image", () => {
  it("posts multipart to adimages and returns the hash", async () => {
    const fetchMock = respond({ images: { "ad.png": { hash: "h1" } } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadAdImage(account, { bytes, filename: "ad.png" })).resolves.toEqual({
      hash: "h1",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/act_1/adimages");
    expect(init.method).toBe("POST");
    // Multipart, not JSON. The docs are explicit and the post() helper in
    // ads.ts sends JSON, which is why this does not use it.
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toBeUndefined();
  });

  it("refuses a filename with no extension, which Meta rejects opaquely", async () => {
    const fetchMock = respond({ images: { a: { hash: "h" } } });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadAdImage(account, { bytes, filename: "ad" })).rejects.toThrow(
      /no file extension/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    const fetchMock = respond({});
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      uploadAdImage(account, { bytes: new Uint8Array(), filename: "ad.png" }),
    ).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a success it cannot read a hash from as a failure", async () => {
    vi.stubGlobal("fetch", respond({ images: {} }));
    await expect(uploadAdImage(account, { bytes, filename: "ad.png" })).rejects.toThrow(
      /returned no hash/,
    );
  });

  it("classifies a Meta refusal the same way a write is classified", async () => {
    vi.stubGlobal("fetch", respond({ error: { message: "bad token", code: 190 } }, false, 400));
    await expect(uploadAdImage(account, { bytes, filename: "ad.png" })).rejects.toThrow(
      /ads_management/,
    );
  });
});

describe("the ad creative", () => {
  const good = {
    name: "P2 static A",
    pageId: "1122",
    imageHash: "h1",
    copy,
    destination: "page",
  };

  it("builds the link_data Meta takes", () => {
    expect(adCreativePayload(good)).toEqual({
      name: "P2 static A",
      object_story_spec: {
        page_id: "1122",
        link_data: {
          image_hash: "h1",
          link: "https://example.com/book",
          message: "Three slots left this month.",
          name: "Book a check-up",
          call_to_action: { type: "BOOK_NOW", value: { link: "https://example.com/book" } },
        },
      },
    });
  });

  it("points the button at the same place as the ad", () => {
    const payload = adCreativePayload(good);
    const linkData = payload.object_story_spec.link_data;
    expect(linkData.call_to_action!.value.link).toBe(linkData.link);
  });

  it("leaves out the description and the button when there are none", () => {
    const payload = adCreativePayload({
      ...good,
      copy: { ...copy, cta: null, description: "  " },
    });
    expect(payload.object_story_spec.link_data).not.toHaveProperty("description");
    expect(payload.object_story_spec.link_data).not.toHaveProperty("call_to_action");
  });

  it("includes a description when given one", () => {
    const payload = adCreativePayload({ ...good, copy: { ...copy, description: "Open Saturdays." } });
    expect(payload.object_story_spec.link_data.description).toBe("Open Saturdays.");
  });

  it("refuses a destination this shape does not fit", () => {
    expect(() => adCreativePayload({ ...good, destination: "message" })).toThrow(
      /different creative shape/,
    );
    expect(() => adCreativePayload({ ...good, destination: "none" })).toThrow(/no link/);
    expect(() => adCreativePayload({ ...good, destination: "post" })).toThrow(/no link/);
  });

  it("refuses a destination that is not https", () => {
    for (const link of ["http://example.com", "example.com", "  ", "javascript:alert(1)"]) {
      expect(() => adCreativePayload({ ...good, copy: { ...copy, link } }), link).toThrow(
        /not an https destination/,
      );
    }
  });

  it("refuses an ad with no words", () => {
    expect(() => adCreativePayload({ ...good, copy: { ...copy, primaryText: " " } })).toThrow(
      /needs primary text/,
    );
    expect(() => adCreativePayload({ ...good, copy: { ...copy, headline: "" } })).toThrow(
      /needs a headline/,
    );
  });

  it("refuses a button that is not Meta's", () => {
    expect(() => adCreativePayload({ ...good, copy: { ...copy, cta: "BOOK_TODAY" } })).toThrow(
      /not a Meta call-to-action/,
    );
  });

  it("refuses a creative missing its page, image or name", () => {
    expect(() => adCreativePayload({ ...good, pageId: " " })).toThrow(/Facebook page/);
    expect(() => adCreativePayload({ ...good, imageHash: "" })).toThrow(/uploaded image/);
    expect(() => adCreativePayload({ ...good, name: "  " })).toThrow(/needs a name/);
  });

  it("posts to adcreatives and returns the id", async () => {
    const fetchMock = respond({ id: "990" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createAdCreative(account, { name: "x" })).resolves.toEqual({ id: "990" });
    expect(fetchMock.mock.calls[0]![0]).toContain("/adcreatives");
  });
});
