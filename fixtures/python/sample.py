# Fixture for manually verifying the LucidHover hover provider (Session 1).
# Hover over each function name below and confirm the tooltip echoes its raw source.

def add(a, b):
    return a + b


def greet(name):
    message = f"Hello, {name}!"
    print(message)
    return message


def double(n):
    return n * 2


def make_counter():
    count = 0

    def increment():
        nonlocal count
        count += 1
        return count

    return increment
