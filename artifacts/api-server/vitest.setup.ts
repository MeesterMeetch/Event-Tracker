/**
 * Test defaults that keep suites focused on the behaviour they are written to
 * check.
 *
 * The bettable-book allowlist (see src/lib/bettable-books.ts) defaults to real
 * bookmaker keys, because in production it is safer to miss an edge than to
 * surface one at a book you cannot bet at. Most suites here use placeholder
 * keys like "book_a" while testing de-vig and EV arithmetic, which has nothing
 * to do with book eligibility, so filtering is disabled globally.
 *
 * Tests that specifically exercise the filter set BETTABLE_BOOKS themselves and
 * restore it afterwards.
 */
process.env.BETTABLE_BOOKS ??= "all";
