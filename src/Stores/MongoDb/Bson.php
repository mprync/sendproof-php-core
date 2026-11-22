<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use MongoDB\BSON\Document;
use MongoDB\BSON\PackedArray;

/**
 * Converts BSON to the plain JSON shape the protocol carries: MongoDB Extended JSON v2 relaxed
 * form, which uses `{"$oid": …}` and `{"$date": …}` for the types JSON lacks.
 */
final class Bson
{
    /**
     * A value as a PHP structure of `stdClass`, arrays and scalars, in relaxed Extended JSON form.
     * Works for documents, arrays, driver values (ObjectId, UTCDateTime) and PHP scalars.
     */
    public static function plain(mixed $value): mixed
    {
        if ($value === null) {
            return null;
        }
        // Extended JSON is defined for documents, so wrap any other value in one.
        $wrapped = $value instanceof Document ? $value : Document::fromPHP(['v' => $value instanceof PackedArray ? $value->toPHP() : $value]);
        $decoded = json_decode($wrapped->toRelaxedExtendedJSON(), false, 512, JSON_THROW_ON_ERROR);

        return $value instanceof Document ? $decoded : $decoded->v;
    }

    /** The relaxed Extended JSON text of a document, used to compare two reads of it. */
    public static function text(Document $document): string
    {
        return $document->toRelaxedExtendedJSON();
    }

    /** A stable key for an `_id` value of any BSON type. */
    public static function idKey(mixed $id): string
    {
        return Document::fromPHP(['_id' => $id])->toCanonicalExtendedJSON();
    }
}
