"""Integration adapters: the glue between one portal and the knowledge layer.

An adapter never talks to the store directly. It turns whatever a driver
produced -- observations, evidence files, a live page -- into records the
runtime can carry, and nothing else.
"""
