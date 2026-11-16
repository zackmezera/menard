/**
 * Fixtures for the jobs tests: the public-domain Quijote paragraph of
 * DESIGN.md §4.3 and synthetic Spanish academic prose written for Menard,
 * reproducing the structure of the four combined-note layouts (§13).
 */

/** Don Quijote I.1 (1605), with a footnote ref and an inline page marker. */
export const QUIJOTE_ES =
	"En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.[^1] Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de %%p. 2%% añadidura los domingos, consumían las tres partes de su hacienda. ^p1";

/** Ormsby's 1885 translation, as the model returns it: placeholders intact. */
export const QUIJOTE_EN_1 =
	"In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.⟦^1⟧";
export const QUIJOTE_EN_2 =
	"An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra ⟦C1⟧ on Sundays, made away with three-quarters of his income.";

/** The translation paragraph of DESIGN.md §4.3, exactly. */
export const QUIJOTE_EN =
	"In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.[^1] An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra %%p. 2%% on Sundays, made away with three-quarters of his income. ^p1";

/**
 * Layout (a): an H1 boundary, a provenance callout in the translation, a
 * bibliography, footnotes `[^n]` in the Spanish and `[^en-n]` in the English,
 * and a trailing personal section.
 */
export const LAYOUT_A = `---
citekey: perezlaberinto2019
tags:
  - texto
---
[[Pérez, Lucía]] · *Revista de Estudios Borgianos* 12 (2019)

# Text

## I. El laberinto como forma

Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.[^1] Esa lectura, dice, fue decisiva para «La muerte y la brújula».

> «Yo soy el que soy»,
> dijo el Señor.
>
> —Éxodo 3, 14

El narrador de [[Ficciones]] no describe el laberinto: lo *recorre*, como observa [la crítica](https://example.org/critica) desde 1960.[^2]

## II. La biblioteca

- Primera edición: Sur, 1944
- Segunda edición: Emecé, 1956

## Bibliografía

Borges, J. L. *Ficciones*. Buenos Aires: Sur, 1944.

[^1]: Véase la carta a Abramowicz, p. 12.
[^2]: Sobre la recepción, cf. Molloy, *Las letras de Borges*, cap. 3.

# English translation

> [!info] Translated by the author for this edition.

## I. The labyrinth as form

According to Mr Pérez (cf. pp. 23-25), J. L. Borges read Poe in Geneva around 1916.[^en-1] That reading, he says, was decisive for “Death and the Compass.”

> “I am who I am,”
> said the Lord.
>
> —Exodus 3:14

The narrator of [[Ficciones]] does not describe the labyrinth: he *walks* it, as [critics](https://example.org/critica) have noted since 1960.[^en-2]

## II. The library

- First edition: Sur, 1944
- Second edition: Emecé, 1956

[^en-1]: See the letter to Abramowicz, p. 12.
[^en-2]: On the reception, cf. Molloy, *Las letras de Borges*, ch. 3.

# For My Work

Compare with the seminar notes on Genette.
`;

/** Layout (b): an H1 boundary after an epigraph, `[^gen-n]` labels, an affiliation line glued to a heading. */
export const LAYOUT_B = `---
citekey: giordanoresistencia
---
# Text

> La resistencia no es un gesto,
> es una forma de durar.

Universidad Nacional de Rosario
## La resistencia como lectura

La lectura resiste al tiempo.[^1] El texto, en cambio, se entrega.

[^1]: Giordano, *Modos del ensayo*, p. 44.

# English translation

> Resistance is not a gesture,
> it is a way of lasting.

National University of Rosario
## Resistance as reading

Reading resists time.[^gen-1] The text, by contrast, gives itself up.

[^gen-1]: Giordano, *Modos del ensayo*, p. 44.

# Argument

The essay argues that reading is a form of endurance.
`;

/** Layout (c): an H2 boundary, inline page markers, a standalone date line, a bare rule before footnotes. */
export const LAYOUT_C = `---
citekey: navarroestilo1930
---
## La ética del estilo

Una vieja costumbre de nuestras letras %%p. 45%% convierte el estilo en adorno. Buenos Aires, 1930.

1930

---

[^1]: Nota del autor.

## English translation

An old habit of our letters %%p. 45%% turns style into ornament. Buenos Aires, 1930.

1930
`;

/** Layout (d): English only, with verse and hard wraps: nothing to split. */
export const LAYOUT_D = `---
citekey: borgesversiones1932
---
## English translation

Perhaps no problem is as consubstantial with letters
and their modest mystery as the one posed by a translation.

> The sea, the sea,
> always beginning again.
`;

/** A source note for Translate note: every unit kind, a skipped bibliography, no ids yet. */
export const SOURCE_NOTE = `---
citekey: perezlaberinto2019
---
# El laberinto como forma

Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.[^1] Esa lectura, dice, fue decisiva para «La muerte y la brújula».

> «Yo soy el que soy»,
> dijo el Señor.

El narrador de [[Ficciones]] no describe el laberinto: lo *recorre*. Como escribió Molloy, “la forma es el sentido” (Molloy 1979, 42).

- Primera edición: Sur, 1944
- Segunda edición: Emecé, 1956

> [!note] Nota del editor
> La primera edición es de 1944. Fue revisada en 1956.

## Bibliografía

Borges, J. L. *Ficciones*. Buenos Aires: Sur, 1944.

[^1]: Véase la carta a Abramowicz, p. 12.
`;

/** An existing Spanish note and its English translation, unpaired and without ids, for Align. */
export const ALIGN_SOURCE = `---
citekey: sarloborges1993
---
## Una poética de la mezcla

Borges escribe desde las orillas. Su literatura mezcla el criollismo con la biblioteca europea.

> «Las calles de Buenos Aires
> ya son mi entraña.»

La crítica, según [Sarlo](https://example.org/sarlo), leyó mal esa mezcla durante décadas.[^1]

[^1]: Sarlo, *Borges, un escritor en las orillas*, p. 15.
`;

export const ALIGN_TARGET = `---
tags: [translation]
---
## A poetics of mixture

Borges writes from the edges. His literature mixes *criollismo* with the European library. [Translator's note: *criollismo* names a nativist current.]

> “The streets of Buenos Aires
> are already my core.”

Critics, according to [Sarlo](https://example.org/sarlo), misread that mixture for decades.[^1]

[^1]: Sarlo, *Borges, un escritor en las orillas*, p. 15.
`;
