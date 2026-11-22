<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/**
 * Reads and replaces a non-public property of a client library's object, for hooks that have no
 * public setter to use (Elasticsearch's transport, OpenSearch's transports and connections, gax's
 * transport). Every step fails closed: when the library's class layout has changed, so the
 * property is gone, static, uninitialised, read-only or doesn't keep the new value, the hook throws
 * `LogicException` at startup instead of creating a stray property and leaving the client unguarded.
 *
 * @internal
 */
final class InternalProperty
{
    /**
     * The value of `$class::$name` on `$target`.
     *
     * @param class-string $class the class that declares the property (a private one is looked up there)
     * @param string $what the client, for the error, such as "an Elasticsearch client"
     * @throws \LogicException
     */
    public static function read(object $target, string $class, string $name, string $what): mixed
    {
        return self::property($target, $class, $name, $what)->getValue($target);
    }

    /**
     * Replaces `$class::$name` on `$target` with what `$wrap` returns for its current value, and
     * checks the object kept it. `$wrap` may return the current value to leave it as it is.
     *
     * @param class-string $class the class that declares the property
     * @param \Closure(mixed): mixed $wrap
     * @return mixed the value the property holds afterwards
     * @throws \LogicException
     */
    public static function replace(object $target, string $class, string $name, \Closure $wrap, string $what): mixed
    {
        $property = self::property($target, $class, $name, $what);
        $current = $property->getValue($target);
        $next = $wrap($current);
        if ($next === $current) {
            return $current;
        }
        try {
            $property->setValue($target, $next);
        } catch (\Error $error) {
            throw self::unsupported($class, $name, $what, $error);
        }
        if ($property->getValue($target) !== $next) {
            throw self::unsupported($class, $name, $what);
        }

        return $next;
    }

    /** @param class-string $class */
    private static function property(object $target, string $class, string $name, string $what): \ReflectionProperty
    {
        if (!$target instanceof $class) {
            throw new \LogicException(sprintf('Sendproof can\'t guard %s: expected a %s, got a %s.', $what, $class, $target::class));
        }
        try {
            $property = new \ReflectionProperty($class, $name);
        } catch (\ReflectionException $error) {
            throw self::unsupported($class, $name, $what, $error);
        }
        if ($property->isStatic() || !$property->isInitialized($target)) {
            throw self::unsupported($class, $name, $what);
        }

        return $property;
    }

    private static function unsupported(string $class, string $name, string $what, ?\Throwable $previous = null): \LogicException
    {
        return new \LogicException(sprintf(
            'Sendproof can\'t guard %s: %s::$%s, which the hook replaces, is missing or has changed in this version of the library. Pin a supported version or report it, rather than run unguarded.',
            $what,
            $class,
            $name,
        ), 0, $previous);
    }
}
